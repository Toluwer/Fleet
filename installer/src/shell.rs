// Windows shell integration: registry, shortcuts, the native folder picker,
// WebView2 detection and a few process helpers.

use std::path::{Path, PathBuf};

use windows::core::{Interface, PCWSTR, PWSTR, BOOL};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, ERROR_SUCCESS, HANDLE, HWND, LPARAM, WAIT_OBJECT_0, WPARAM,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_OPTION_NON_VOLATILE, REG_VALUE_TYPE,
    RRF_RT_REG_SZ, REG_CREATE_KEY_DISPOSITION,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_ACCESS_RIGHTS, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};
use windows::Win32::UI::Shell::{
    SHBrowseForFolderW, SHCreateItemFromParsingName, SHGetPathFromIDListW,
    SHGetSpecialFolderPathW, ShellExecuteW, BROWSEINFOW, FileOpenDialog, IFileDialog,
    IShellItem, IShellLinkW, ShellLink, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, PostMessageW, SW_SHOWNORMAL, WM_CLOSE,
};

// ------------------------------------------------------------------ helpers

pub fn log_str(s: &str) {
    if std::env::var_os("FLEET_SETUP_LOG").is_some() {
        let line = format!("[fleet-setup/shell] {s}\r\n");
        let p = std::env::temp_dir().join("FleetSetup.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
}

pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn wide_to_string(p: PWSTR) -> String {
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.as_ptr() as *const core::ffi::c_void));
        s
    }
}

pub fn local_app_data() -> PathBuf {
    let mut buf = [0u16; 260];
    unsafe {
        if SHGetSpecialFolderPathW(None, &mut buf, CSIDL_LOCALAPPDATA as i32, true).as_bool() {
            return wide_buf_to_path(&buf);
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local);
    }
    PathBuf::from(r"C:\Users\Public")
}

pub fn special_folder(csidl: u32) -> PathBuf {
    let mut buf = [0u16; 260];
    unsafe {
        if SHGetSpecialFolderPathW(None, &mut buf, csidl as i32, true).as_bool() {
            return wide_buf_to_path(&buf);
        }
    }
    PathBuf::new()
}

fn wide_buf_to_path(buf: &[u16; 260]) -> PathBuf {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    PathBuf::from(String::from_utf16_lossy(&buf[..len]))
}

pub const CSIDL_PROGRAMS: u32 = 2;
pub const CSIDL_DESKTOPDIRECTORY: u32 = 16;
const CSIDL_LOCALAPPDATA: u32 = 28;

// ------------------------------------------------------------------ registry

fn reg_create(subkey: &str) -> Result<HKEY, String> {
    let wsub = to_wide(subkey);
    let mut hkey = HKEY::default();
    let r = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(wsub.as_ptr()),
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            windows::Win32::System::Registry::KEY_SET_VALUE,
            None,
            &mut hkey,
            None::<*mut REG_CREATE_KEY_DISPOSITION>,
        )
    };
    if r != ERROR_SUCCESS {
        return Err(format!("could not open registry key {subkey}"));
    }
    Ok(hkey)
}

fn reg_set_string(hkey: HKEY, name: &str, value: &str) -> Result<(), String> {
    let wname = to_wide(name);
    let mut wvalue = to_wide(value);
    let ok = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(wname.as_ptr()),
            None,
            REG_VALUE_TYPE(1u32), // REG_SZ
            Some(std::slice::from_raw_parts_mut(
                wvalue.as_mut_ptr().cast::<u8>(),
                wvalue.len() * 2,
            )),
        ) == ERROR_SUCCESS
    };
    if ok {
        Ok(())
    } else {
        Err(format!("could not write registry value {name}"))
    }
}

fn reg_set_dword(hkey: HKEY, name: &str, value: u32) -> Result<(), String> {
    let wname = to_wide(name);
    let bytes = value.to_le_bytes();
    let ok = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(wname.as_ptr()),
            None,
            REG_VALUE_TYPE(4u32), // REG_DWORD
            Some(&bytes),
        ) == ERROR_SUCCESS
    };
    if ok {
        Ok(())
    } else {
        Err(format!("could not write registry value {name}"))
    }
}

/// Opens/creates a key and writes one REG_SZ value into it.
fn reg_set_value_string(subkey: &str, name: &str, value: &str) -> Result<(), String> {
    let hkey = reg_create(subkey)?;
    let result = reg_set_string(hkey, name, value);
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    result
}

/// Writes the standard "Add/Remove Programs" entries (per-user install).
pub fn write_install_entries(
    install_dir: &Path,
    exe: &Path,
    uninstall: &Path,
    version: &str,
    estimated_kb: u32,
) -> Result<(), String> {
    let key = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fleet";
    let hkey = reg_create(key)?;
    let result = (|| -> Result<(), String> {
        let dir_s = install_dir.to_string_lossy().to_string();
        let exe_s = exe.to_string_lossy().to_string();
        let un_s = uninstall.to_string_lossy().to_string();
        reg_set_string(hkey, "DisplayName", "Fleet")?;
        reg_set_string(hkey, "DisplayVersion", version)?;
        reg_set_string(hkey, "Publisher", "Toluwa")?;
        reg_set_string(hkey, "InstallLocation", &dir_s)?;
        reg_set_string(hkey, "DisplayIcon", &exe_s)?;
        reg_set_string(hkey, "UninstallString", &format!("\"{un_s}\" --uninstall"))?;
        reg_set_string(hkey, "MainBinaryName", "Fleet.exe")?;
        reg_set_dword(hkey, "NoModify", 1)?;
        reg_set_dword(hkey, "NoRepair", 1)?;
        reg_set_dword(hkey, "EstimatedSize", estimated_kb)?;
        Ok(())
    })();
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    result?;

    // Parity with the old installer's manufacturer key.
    let hkey = reg_create("Software\\Toluwa\\Fleet")?;
    let result = reg_set_string(hkey, "", &install_dir.to_string_lossy());
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    result
}

pub fn remove_install_entries() {
    unsafe {
        let _ = RegDeleteTreeW(
            HKEY_CURRENT_USER,
            PCWSTR(to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fleet").as_ptr()),
        );
        let _ = RegDeleteTreeW(
            HKEY_CURRENT_USER,
            PCWSTR(to_wide("Software\\Toluwa").as_ptr()),
        );
    }
}

fn reg_query_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
    let wsub = to_wide(subkey);
    let wname = to_wide(value);
    let mut buf = [0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(
            root,
            PCWSTR(wsub.as_ptr()),
            PCWSTR(wname.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast::<core::ffi::c_void>()),
            Some(&mut len),
        ) == ERROR_SUCCESS
    };
    if !ok {
        return None;
    }
    let chars = ((len as usize) / 2).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..chars]).trim_end_matches('\0').to_string())
}

// ------------------------------------------------------------------ WebView2

const WEBVIEW2_PV: &str =
    "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

pub fn webview2_installed() -> bool {
    reg_query_string(HKEY_LOCAL_MACHINE, WEBVIEW2_PV, "pv")
        .or_else(|| reg_query_string(HKEY_CURRENT_USER, WEBVIEW2_PV, "pv"))
        .map(|v| !v.is_empty() && v != "0.0.0.0")
        .unwrap_or(false)
}

/// Runs the bundled WebView2 bootstrapper silently, waiting for completion.
pub fn install_webview2(bootstrapper: &Path) -> Result<(), String> {
    let status = std::process::Command::new(bootstrapper)
        .args(["/silent", "/install"])
        .status()
        .map_err(|e| format!("could not start the WebView2 setup\n{e}"))?;
    let _ = std::fs::remove_file(bootstrapper);
    if !status.success() && !webview2_installed() {
        return Err(
            "The WebView2 runtime could not be installed.\nYou can retry, or install it from Microsoft's website.".into(),
        );
    }
    Ok(())
}

// ------------------------------------------------------------------ shortcuts

pub fn create_shortcut(
    lnk: &Path,
    target: &Path,
    workdir: &Path,
    description: &str,
) -> Result<(), String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("shortcut setup failed\n{e}"))?;
        link.SetPath(PCWSTR(to_wide(&target.to_string_lossy()).as_ptr()))
            .map_err(|e| format!("shortcut setup failed\n{e}"))?;
        link.SetWorkingDirectory(PCWSTR(to_wide(&workdir.to_string_lossy()).as_ptr()))
            .map_err(|e| format!("shortcut setup failed\n{e}"))?;
        link.SetDescription(PCWSTR(to_wide(description).as_ptr()))
            .map_err(|e| format!("shortcut setup failed\n{e}"))?;
        let persist: IPersistFile = link
            .cast()
            .map_err(|e| format!("shortcut setup failed\n{e}"))?;
        persist
            .Save(PCWSTR(to_wide(&lnk.to_string_lossy()).as_ptr()), true)
            .map_err(|e| format!("could not save shortcut {}\n{e}", lnk.display()))?;
    }
    Ok(())
}

// ------------------------------------------------------------------ folder picker

/// Opens the real, modern Windows folder picker (IFileDialog) with a
/// SHBrowseForFolder fallback. Returns the chosen folder, or None on cancel.
pub fn pick_folder(owner: HWND, title: &str, start_dir: &Path) -> Option<PathBuf> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let dialog: IFileDialog = match CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) {
            Ok(d) => d,
            Err(e) => {
                log_str(&format!("pick_folder: CoCreateInstance failed: {e}"));
                return browse_folder_fallback(owner, title, start_dir);
            }
        };
        log_str("pick_folder: dialog created");

        let mut options = match dialog.GetOptions() {
            Ok(o) => o,
            Err(e) => {
                log_str(&format!("pick_folder: GetOptions failed: {e}"));
                return browse_folder_fallback(owner, title, start_dir);
            }
        };
        options |= windows::Win32::UI::Shell::FOS_PICKFOLDERS
            | windows::Win32::UI::Shell::FOS_FORCEFILESYSTEM
            | windows::Win32::UI::Shell::FOS_PATHMUSTEXIST;
        if dialog.SetOptions(options).is_err() {
            log_str("pick_folder: SetOptions failed");
            return browse_folder_fallback(owner, title, start_dir);
        }
        let _ = dialog.SetTitle(PCWSTR(to_wide(title).as_ptr()));
        if let Some(parent) = start_dir.parent() {
            log_str("pick_folder: creating item from parsing name");
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(
                PCWSTR(to_wide(&parent.to_string_lossy()).as_ptr()),
                None,
            ) {
                let _ = dialog.SetFolder(&item);
            }
        }
        log_str("pick_folder: calling Show");
        match dialog.Show(Some(owner)) {
            Ok(()) => {}
            Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => {
                log_str("pick_folder: cancelled");
                return None;
            }
            Err(e) => {
                log_str(&format!("pick_folder: Show failed {e}, falling back"));
                return browse_folder_fallback(owner, title, start_dir);
            }
        }
        log_str("pick_folder: Show returned");
        let item: IShellItem = match dialog.GetResult() {
            Ok(item) => item,
            Err(_) => return None,
        };
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let s = wide_to_string(name);
        if s.is_empty() {
            None
        } else {
            Some(PathBuf::from(s))
        }
    }
}

unsafe fn browse_folder_fallback(owner: HWND, title: &str, start: &Path) -> Option<PathBuf> {
    log_str("pick_folder: using SHBrowseForFolder fallback");
    let wtitle = to_wide(title);
    let wstart = to_wide(&start.to_string_lossy());
    let bi = BROWSEINFOW {
        hwndOwner: owner,
        pidlRoot: std::ptr::null_mut(),
        pszDisplayName: PWSTR::null(),
        lpszTitle: PCWSTR(wtitle.as_ptr()),
        ulFlags: 0x0011, // BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
        lpfn: None,
        lParam: LPARAM_OF(&wstart),
        iImage: 0,
    };
    let pidl: *mut ITEMIDLIST = SHBrowseForFolderW(&bi);
    if pidl.is_null() {
        return None;
    }
    let mut buf = [0u16; 260];
    let got = SHGetPathFromIDListW(pidl, &mut buf);
    CoTaskMemFree(Some(pidl.cast::<core::ffi::c_void>()));
    if !got.as_bool() {
        return None;
    }
    let s = String::from_utf16_lossy(
        &buf[..buf.iter().position(|c| *c == 0).unwrap_or(buf.len())],
    );
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn LPARAM_OF(w: &Vec<u16>) -> windows::Win32::Foundation::LPARAM {
    // Points at the wide string kept alive by the caller for the dialog.
    windows::Win32::Foundation::LPARAM(w.as_ptr() as isize)
}

// ------------------------------------------------------------------ install state

/// Reads the ProductVersion (falling back to FileVersion) straight out of a
/// .exe's VERSIONINFO resource - the one source of truth about what is
/// actually installed that cannot drift out of sync with the files.
pub fn exe_file_version(path: &Path) -> Option<String> {
    unsafe {
        let wpath = to_wide(&path.to_string_lossy());
        let size = GetFileVersionInfoSizeW(PCWSTR(wpath.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(
            PCWSTR(wpath.as_ptr()),
            None,
            size,
            data.as_mut_ptr().cast(),
        )
        .is_err()
        {
            return None;
        }
        // Ask for the language/codepage the resource actually uses, then
        // query its version strings; a couple of well-known blocks cover
        // resources without a translation table.
        let mut probes: Vec<String> = Vec::new();
        let mut block: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut block_len = 0u32;
        let trans = to_wide("\\VarFileInfo\\Translation");
        if VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(trans.as_ptr()),
            &mut block,
            &mut block_len,
        )
        .as_bool()
            && block_len >= 4
        {
            let words = block as *const u16;
            let lang = *words;
            let codepage = *words.add(1);
            probes.push(format!("\\StringFileInfo\\{lang:04X}{codepage:04X}\\ProductVersion"));
            probes.push(format!("\\StringFileInfo\\{lang:04X}{codepage:04X}\\FileVersion"));
        }
        for probe in [
            "\\StringFileInfo\\040904B0\\ProductVersion",
            "\\StringFileInfo\\040904E4\\ProductVersion",
            "\\StringFileInfo\\040904B0\\FileVersion",
        ] {
            probes.push(probe.to_string());
        }
        for probe in &probes {
            let wprobe = to_wide(probe);
            let mut value: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut value_len = 0u32;
            if VerQueryValueW(
                data.as_ptr().cast(),
                PCWSTR(wprobe.as_ptr()),
                &mut value,
                &mut value_len,
            )
            .as_bool()
                && value_len > 0
            {
                let chars = std::slice::from_raw_parts(value as *const u16, value_len as usize);
                let s = String::from_utf16_lossy(chars)
                    .trim_end_matches('\0')
                    .trim()
                    .to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
        None
    }
}

/// The installed Fleet this installer can see: (folder, version). The
/// version comes from the Fleet.exe on disk whenever it carries one - the
/// registry entry is only the fallback, because a failed in-app update used
/// to bump it without swapping the files, which left every later installer
/// claiming "already up to date" while the app stayed old. A disagreement
/// also repairs the registry entry on the spot, so broken installs heal.
pub fn installed_fleet() -> Option<(PathBuf, String)> {
    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fleet";
    let reg_version =
        reg_query_string(HKEY_CURRENT_USER, KEY, "DisplayVersion").unwrap_or_default();
    let location =
        reg_query_string(HKEY_CURRENT_USER, KEY, "InstallLocation").unwrap_or_default();
    let has_app = |d: &Path| d.is_dir() && d.join("Fleet.exe").is_file();
    let dir = if !location.is_empty() && has_app(Path::new(&location)) {
        PathBuf::from(location)
    } else {
        // Stale or hand-edited entry: trust the default folder only when
        // Fleet is really there.
        let fallback = local_app_data().join("Fleet");
        if has_app(&fallback) {
            fallback
        } else {
            return None;
        }
    };

    let file_version = exe_file_version(&dir.join("Fleet.exe"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let version = match file_version {
        Some(file_version) => {
            if file_version != reg_version {
                log_str(&format!(
                    "installed_fleet: registry says v{reg_version} but Fleet.exe is v{file_version}; trusting the file and fixing the entry"
                ));
                let _ = reg_set_value_string(KEY, "DisplayVersion", &file_version);
            }
            file_version
        }
        None => reg_version,
    };
    Some((dir, version))
}

// ------------------------------------------------------------------ process close

/// Case-insensitive "path is inside dir" check (Windows paths).
fn path_is_under(path: &Path, dir: &Path) -> bool {
    let lower = |p: &Path| -> Vec<String> {
        p.components()
            .filter_map(|c| c.as_os_str().to_str().map(|s| s.to_ascii_lowercase()))
            .collect()
    };
    let (a, b) = (lower(path), lower(dir));
    !b.is_empty() && a.len() >= b.len() && a[..b.len()] == b[..]
}

struct CloseCtx<'a> {
    pids: &'a [u32],
}

unsafe extern "system" fn enum_post_close(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &*(lparam.0 as *const CloseCtx);
    let mut pid = 0u32;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != 0 && ctx.pids.contains(&pid) {
        // Ask nicely first; force only after the grace period below.
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    BOOL(1)
}

/// Closes every Fleet.exe / node.exe process running from `dir` so an update
/// can replace the previous version's files. Graceful WM_CLOSE first, a five
/// second grace period, then force-termination for anything still alive.
/// Processes from other folders are never touched.
pub fn close_fleet_processes(dir: &Path) {
    let me = std::process::id();
    let mut pids: Vec<u32> = Vec::new();
    let mut handles: Vec<HANDLE> = Vec::new();

    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                if pid != 0 && pid != me {
                    // QUERY_LIMITED_INFORMATION | TERMINATE | SYNCHRONIZE
                    let access = PROCESS_ACCESS_RIGHTS(
                        PROCESS_QUERY_LIMITED_INFORMATION.0
                            | PROCESS_TERMINATE.0
                            | 0x0010_0000,
                    );
                    if let Ok(h) = OpenProcess(access, false, pid) {
                        let mut buf = [0u16; 1024];
                        let mut len = buf.len() as u32;
                        let image = QueryFullProcessImageNameW(
                            h,
                            PROCESS_NAME_WIN32,
                            PWSTR(buf.as_mut_ptr()),
                            &mut len,
                        )
                        .ok()
                        .map(|_| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])));
                        match image {
                            Some(p) if path_is_under(&p, dir) => {
                                pids.push(pid);
                                handles.push(h);
                            }
                            _ => {
                                let _ = CloseHandle(h);
                            }
                        }
                    }
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    if pids.is_empty() {
        return;
    }
    log_str(&format!(
        "close_fleet_processes: closing {} process(es) running from {}",
        pids.len(),
        dir.display()
    ));

    // 1. Graceful: WM_CLOSE to every window those processes own.
    let ctx = CloseCtx { pids: &pids };
    unsafe {
        let _ = EnumWindows(
            Some(enum_post_close),
            LPARAM(&ctx as *const CloseCtx as isize),
        );
    }

    // 2. Grace period, then force-terminate the survivors.
    let deadline = unsafe { GetTickCount64() } + 5000;
    loop {
        let alive = handles
            .iter()
            .filter(|h| unsafe { WaitForSingleObject(**h, 0) } != WAIT_OBJECT_0)
            .count();
        if alive == 0 {
            return;
        }
        if unsafe { GetTickCount64() } >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    for h in &handles {
        if unsafe { WaitForSingleObject(*h, 0) } != WAIT_OBJECT_0 {
            let _ = unsafe { TerminateProcess(*h, 0) };
        }
    }
    // Give the OS a beat to release the file locks before the caller
    // starts deleting and rewriting the folder.
    std::thread::sleep(std::time::Duration::from_millis(400));
}

// ------------------------------------------------------------------ misc

/// Removes the previous version's files from `dir` - every file and folder
/// inside it, except the running installer itself - so nothing from an older
/// Fleet is left behind. A file that is still locked gets parked under a
/// `.fleetoldNNN` name (running executables can be renamed but not deleted);
/// the next install's sweep deletes it.
pub fn wipe_dir(dir: &Path) -> Result<(), String> {
    let me = std::env::current_exe().ok();
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("could not read the previous install folder\n{e}"))?;
    for entry in entries.flatten() {
        let p = entry.path();
        if me.as_deref() == Some(p.as_path()) {
            continue; // never delete the exe we are running from
        }
        let removed = if p.is_dir() {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_file(&p).or_else(|_| {
                let parked = p.with_extension(format!("fleetold{}", std::process::id()));
                std::fs::rename(&p, &parked).map(|_| ())
            })
        };
        if let Err(e) = removed {
            return Err(format!(
                "A file from the previous version couldn't be removed.\n{}\nClose Fleet, then try again.\n\n{e}",
                p.display()
            ));
        }
    }
    Ok(())
}

pub fn launch_app(exe: &Path, workdir: &Path) -> bool {
    unsafe {
        let r = ShellExecuteW(
            None,
            PCWSTR(to_wide("open").as_ptr()),
            PCWSTR(to_wide(&exe.to_string_lossy()).as_ptr()),
            None,
            PCWSTR(to_wide(&workdir.to_string_lossy()).as_ptr()),
            SW_SHOWNORMAL,
        );
        // ShellExecuteW returns a HINSTANCE > 32 on success.
        (r.0 as usize) > 32
    }
}

/// Opens a URL in the user's default browser. Used for the "get a newer
/// version" escape hatch on the up-to-date screen - re-running an old
/// downloaded installer otherwise traps people on their old version.
pub fn open_url(url: &str) -> bool {
    unsafe {
        let r = ShellExecuteW(
            None,
            PCWSTR(to_wide("open").as_ptr()),
            PCWSTR(to_wide(url).as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
        (r.0 as usize) > 32
    }
}

/// A running executable can still be renamed on Windows. We use that to clear
/// the way for a fresh install, deleting the stale copy afterwards.
pub fn rotate_if_locked(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let tmp = path.with_extension(format!("fleetold{}", std::process::id()));
    match std::fs::rename(path, &tmp) {
        Ok(()) => {
            let _ = std::fs::remove_file(&tmp);
            Ok(())
        }
        Err(e) => Err(format!(
            "{} seems to be running.\nClose it, then try again.\n\n{e}",
            path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default()
        )),
    }
}

pub fn clean_rotated(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(".fleetold") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Best-effort self-delete for the uninstaller. A running executable can be
/// renamed on Windows, so we move ourselves into the temp folder and sweep any
/// stale copy left by an earlier uninstall. No helper `cmd /c ping & del`
/// process is spawned - that exact self-delete recipe is a well-known malware
/// TTP and antivirus engines score it heavily; one small stray file in temp
/// (reclaimed by Windows storage sense) is the safer trade.
pub fn self_delete() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let tmp = std::env::temp_dir().join("FleetUninstall.exe");
    let _ = std::fs::remove_file(&tmp); // stale copy from a previous uninstall
    if std::fs::rename(&exe, &tmp).is_err() {
        // Rename failed (e.g. cross-volume): copy out so the folder sweep below
        // can still delete the original.
        let _ = std::fs::copy(&exe, &tmp);
    }
}
