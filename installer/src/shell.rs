// Windows shell integration: registry, shortcuts, the native folder picker,
// WebView2 detection and a few process helpers.

use std::path::{Path, PathBuf};

use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_CANCELLED, ERROR_SUCCESS, HWND};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_OPTION_NON_VOLATILE, REG_VALUE_TYPE,
    RRF_RT_REG_SZ, REG_CREATE_KEY_DISPOSITION,
};
use windows::Win32::UI::Shell::{
    SHBrowseForFolderW, SHCreateItemFromParsingName, SHGetPathFromIDListW,
    SHGetSpecialFolderPathW, ShellExecuteW, BROWSEINFOW, FileOpenDialog, IFileDialog,
    IShellItem, IShellLinkW, ShellLink, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

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

// ------------------------------------------------------------------ misc

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

/// Best-effort self-delete for the uninstaller: move the running exe to temp,
/// then let a detached `cmd` remove it once this process has exited.
pub fn self_delete() {
    use std::os::windows::process::CommandExt;
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let tmp = std::env::temp_dir().join("FleetUninstall.exe");
    if std::fs::rename(&exe, &tmp).is_err() {
        let _ = std::fs::copy(&exe, &tmp);
    }
    let script = format!(
        "/c ping -n 3 127.0.0.1 >nul & del /f /q \"{}\"",
        tmp.to_string_lossy()
    );
    let _ = std::process::Command::new("cmd.exe")
        .arg(script)
        .creation_flags(0x0000_0008) // DETACHED_PROCESS
        .spawn();
}
