// Fleet's installer - one page, no wizard.
//
// The window IS the installer: a fixed Fleet-branded header (logo, wordmark,
// version) and a content area that swaps in place - install form -> progress
// -> done - never a chain of "Next >" pages. It matches Fleet's own dark
// theme, and every interactive control is a REAL native Windows control
// (BUTTON / EDIT / STATIC / msctls_progress32, comctl32 v6 visual styles
// with the DarkMode_Explorer subclass, a dark immersive title bar). Nothing
// is owner-drawn; no fake chrome anywhere.
//
// Flow (fresh):     one page: folder + shortcut -> Install Fleet -> progress -> done.
// Flow (update):    one page: v{old} -> v{new} -> Update Fleet -> progress -> done.
// Flow (same ver):  one page: "Fleet is up to date." -> Close.
// Flow (uninstall): one page: Remove Fleet? -> progress -> gone.

#![cfg_attr(not(feature = "console"), windows_subsystem = "windows")]

mod payload;
mod shell;
mod net;

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWINDOWATTRIBUTE};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, CreateSolidBrush, DeleteObject, SetBkColor, SetBkMode, SetTextColor, TRANSPARENT,
    FONT_CHARSET, FONT_CLIP_PRECISION, FONT_OUTPUT_PRECISION, FONT_QUALITY,
    HBRUSH, HFONT, HGDIOBJ, HDC,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::Controls::{
    InitCommonControlsEx, INITCOMMONCONTROLSEX, PBM_SETBARCOLOR, PBM_SETBKCOLOR, PBM_SETPOS,
    PBM_SETRANGE32, SetWindowTheme,
};
use windows::Win32::UI::HiDpi::{GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRect, BN_CLICKED, BM_GETCHECK, BM_SETCHECK, CREATESTRUCTW, CW_USEDEFAULT,
    DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW, GetClassNameW, GetDlgCtrlID, GetMessageW,
    GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GWLP_USERDATA, HICON, HMENU, HWND_TOP,
    IDC_ARROW, IDI_APPLICATION, IMAGE_ICON, IDOK, IsDialogMessageW, IsWindowVisible, KillTimer,
    LoadCursorW, LoadIconW, LoadImageW, LR_DEFAULTCOLOR, MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassW,
    SendMessageW, SetLayeredWindowAttributes, SetTimer, SetWindowLongPtrW, SetWindowPos,
    SetWindowTextW, ShowWindow, STM_SETIMAGE,
    SystemParametersInfoW, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    WS_CAPTION, WS_EX_CLIENTEDGE, WS_EX_LAYERED, WS_MINIMIZEBOX, WS_SYSMENU,
    LWA_ALPHA, MB_DEFBUTTON2, MB_ICONQUESTION, MB_OKCANCEL, MSG,
    SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER, SPI_GETWORKAREA,
    WM_CLOSE, WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC, WM_CTLCOLOREDIT, WM_DPICHANGED, WM_NCDESTROY,
    WM_NCCREATE, WM_SETFONT, WM_TIMER,
};

use payload::Package;
use shell::{to_wide, CSIDL_DESKTOPDIRECTORY, CSIDL_PROGRAMS};

// ------------------------------------------------------------------ branding

const FLEET_VERSION: &str = env!("FLEET_VERSION");
const APP_TITLE: &str = "Fleet Setup";
const UNINSTALL_TITLE: &str = "Fleet Uninstaller";

// Fleet's own palette (COLORREF is 0x00BBGGRR).
const BG: u32     = 0x0013_0F0E; // #0e0f13 deep graphite window
const INK: u32    = 0x00F1_F0F4; // #f4f0f1 primary text
const INK_2: u32  = 0x00A7_A3AA; // #aaa3a7 secondary text
const INK_3: u32  = 0x0071_6C72; // #726c71 muted text
const HAIR: u32   = 0x002E_2626; // #26262e hairlines
const TRACK: u32  = 0x0034_2D2C; // #2c2d34 progress track
const ACCENT: u32 = 0x00F6_823B; // #3b82f6 Fleet blue
const DANGER: u32 = 0x00AC_9BFF; // #ff9bac error text

// Timer ids
const IDT_FADE: usize = 1;
const IDT_DEMO: usize = 3;
const IDT_POLL: usize = 4;
const IDT_RESOLVE: usize = 5;
const IDT_SWEEP: usize = 6;

// Static control ids (drive per-control colors)
const IDC_HEAD: i32 = 1;    // headings + wordmark -> INK
const IDC_SUB: i32 = 2;     // body lines -> INK_2
const IDC_PATH: i32 = 3;    // emphasized path -> INK
const IDC_HINT: i32 = 4;    // muted notes -> INK_3
const IDC_ERROR: i32 = 5;   // inline validation error -> DANGER
const IDC_BYTES: i32 = 6;   // progress bytes -> INK_3
const IDC_FILE: i32 = 7;    // current file -> INK_3
const IDC_TAG: i32 = 8;     // header tagline -> INK_3
const IDC_VERSION: i32 = 9; // header version -> INK_3
const IDC_LABEL: i32 = 10;  // form label -> INK_2
const IDC_RULE: i32 = 11;   // 1px hairline (filled with the hair brush)

// Interactive control ids
const IDC_PATHEDIT: i32 = 120;
const IDC_BROWSE: i32 = 101;
const IDC_INSTALL: i32 = 103;
const IDC_LAUNCH: i32 = 105;
const IDC_CLOSE: i32 = 106;
const IDC_CHECK_DESKTOP: i32 = 107;
const IDC_REMOVE: i32 = 110;
const IDC_CHECK_DATA: i32 = 112;
const IDC_RETRY: i32 = 113;
const IDC_RELEASES: i32 = 114;
// Esc / cancel command id (Win32 IDCANCEL == 2).
const IDC_CANCEL: i32 = 2;

// Window metrics (logical pixels at 96 DPI)
const WIN_W: i32 = 520;
const WIN_H: i32 = 376;

// ------------------------------------------------------------------ state

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    /// Transient (an install already exists): checking the release feed.
    Resolve,
    /// The one install page: folder picker + shortcut option.
    Fresh,
    UpdateReady,
    UpToDate,
    Installing,
    Done,
    Error,
    UninstallConfirm,
    Uninstalling,
    Uninstalled,
}

enum Msg {
    File(String),
    Bytes(u64, u64),
    Note(String),
    Done,
    Err(String),
}

#[derive(Clone, Copy)]
struct Fonts {
    display: HFONT, // wordmark
    head: HFONT,    // section headings
    body: HFONT,
    path: HFONT,
    small: HFONT,
}

enum After {
    None,
    Quit,
}

struct Fade {
    active: bool,
    from: u8,
    to: u8,
    t0: u64,
    dur: u32,
    after: After,
}

struct App {
    hwnd: HWND,
    hinst: windows::Win32::Foundation::HINSTANCE,
    brush: HBRUSH,
    hair_brush: HBRUSH,
    fonts: Fonts,
    scale: f32,
    uninstall_mode: bool,
    demo: bool,
    stage: Stage,
    ctrls: Vec<HWND>,
    alpha: u8,
    path: String,
    desktop_shortcut: bool,
    delete_data: bool,
    last_error: String,
    install_dest: PathBuf,
    rx: Option<Receiver<Msg>>,
    busy: bool,
    fade: Fade,
    /// (folder, version) of the Fleet already on this PC, if any. Decides
    /// whether this run is a fresh install, an update, or a no-op.
    installed: Option<(PathBuf, String)>,
    /// True when this run replaces an older installed version.
    updating: bool,
    /// The newest release published on GitHub, when the feed could be read.
    /// None until the check finishes (or fails, in which case it stays None
    /// and the embedded payload is what gets installed).
    latest: Option<net::Latest>,
    /// Shared with the feed thread: None = still checking, Some(None) = the
    /// feed could not be read, Some(Some(latest)) = resolved.
    feed: Arc<Mutex<Option<Option<net::Latest>>>>,
    /// GetTickCount64 deadline after which a slow feed check gives up.
    resolve_deadline: u64,
    /// True while the release-feed check is still in flight (Install stays
    /// disabled so nobody installs an old payload mid-check).
    resolving: bool,
    /// Indeterminate-progress sweep position (uninstalling).
    sweep: i32,
    /// The 48px Fleet logo loaded for the current DPI.
    hlogo: Option<HANDLE>,
}

// ------------------------------------------------------------------ helpers

fn debug_log(s: &str) {
    if std::env::var_os("FLEET_SETUP_LOG").is_some() {
        let line = format!("[fleet-setup] {s}\r\n");
        let p = std::env::temp_dir().join("FleetSetup.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
}

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_048_576.0)
}

/// Compares dotted versions ("1.5.12" vs "1.6"); non-numeric parts are 0.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let nums = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (nums(a), nums(b));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            o => return o,
        }
    }
    std::cmp::Ordering::Equal
}

/// Validates a typed/chosen install folder. Returns the cleaned path.
fn validate_path(raw: &str) -> Result<String, &'static str> {
    let t = raw.trim().trim_matches('"').trim();
    if t.is_empty() {
        return Err("Type a folder path, like C:\\Apps\\Fleet.");
    }
    let unc = t.starts_with("\\\\");
    if !unc {
        let b = t.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return Err("Use a full path that starts with a drive, like C:\\Apps\\Fleet.");
        }
        if b.len() == 3 {
            return Err("Pick a folder, not an entire drive.");
        }
    }
    let body = if unc { &t[2..] } else { &t[3..] };
    if body.contains(':') {
        return Err("That character isn't allowed in a folder path.");
    }
    for ch in ['<', '>', '|', '?', '*'] {
        if body.contains(ch) {
            return Err("That character isn't allowed in a folder path.");
        }
    }
    let mut cleaned = t.to_string();
    while cleaned.len() > 3 && cleaned.ends_with('\\') {
        cleaned.pop();
    }
    Ok(cleaned)
}

fn make_font(face: PCWSTR, weight: i32, logical_height: i32, scale: f32) -> HFONT {
    let h = -((logical_height as f32 * scale).round() as i32);
    unsafe {
        CreateFontW(
            h,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            FONT_CHARSET(1), // DEFAULT_CHARSET
            FONT_OUTPUT_PRECISION(0),
            FONT_CLIP_PRECISION(0),
            FONT_QUALITY(5), // CLEARTYPE_QUALITY
            0x22,            // VARIABLE_PITCH | FF_SWISS
            face,
        )
    }
}

/// Native dark visual style for interactive controls: the same subclass
/// Explorer's own dark mode rides on (Windows 10 1809+ / Windows 11). The
/// controls stay 100% native - this only asks comctl32 for its dark skin.
unsafe fn dark_control(hwnd: HWND) {
    let _ = SetWindowTheme(hwnd, w!("DarkMode_Explorer"), None);
}

/// Dark immersive title bar so the caption matches the client area
/// (DWMWA_USE_IMMERSIVE_DARK_MODE; the older attribute 19 on pre-20H1 builds).
unsafe fn dark_titlebar(hwnd: HWND) {
    let mut on: i32 = 1;
    let pv: *const core::ffi::c_void = &mut on as *const i32 as *const core::ffi::c_void;
    let cb = std::mem::size_of::<i32>() as u32;
    if DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, pv, cb).is_err() {
        // Attribute 20 landed in Windows 10 20H1; older builds know it as 19.
        let _ = DwmSetWindowAttribute(hwnd, DWMWINDOWATTRIBUTE(19), pv, cb);
    }
}

/// Loads the Fleet logo (embedded icon resource) at 48 logical px.
unsafe fn load_logo(a: &mut App) {
    let size = (48.0 * a.scale).round().max(16.0) as i32;
    if let Ok(h) = LoadImageW(
        Some(a.hinst),
        PCWSTR(1 as *const u16), // MAKEINTRESOURCE(1) - the embedded icon
        IMAGE_ICON,
        size,
        size,
        LR_DEFAULTCOLOR,
    ) {
        if let Some(old) = a.hlogo.replace(h) {
            let _ = DestroyIcon(HICON(old.0));
        }
    } else {
        debug_log("logo LoadImageW failed - running without the header logo");
    }
}

// ------------------------------------------------------------------ install workers

fn run_install(
    dest: &PathBuf,
    desktop: bool,
    version: &str,
    is_update: bool,
    latest: Option<net::Latest>,
    tx: &Sender<Msg>,
) -> Result<(), String> {
    debug_log("run_install start");
    // A published release newer than this installer's embedded payload gets
    // installed instead of it: that is what makes an old installer exe still
    // hand out the newest Fleet. Same folder, same flow, same verification.
    let fetch_latest = latest
        .as_ref()
        .map(|l| version_cmp(&l.version, FLEET_VERSION) == std::cmp::Ordering::Greater)
        .unwrap_or(false);
    let pkg = if fetch_latest {
        let l = latest.as_ref().unwrap();
        let _ = tx.send(Msg::Note(format!(
            "Downloading Fleet v{} - the newest release…",
            l.version
        )));
        let url = net::asset_url(&l.zip_name);
        debug_log(&format!("fetching newer release {url}"));
        let tx_progress = tx.clone();
        let mut progress = move |done: u64, total: u64| {
            let _ = tx_progress.send(Msg::Bytes(done, total));
        };
        let bytes = net::http_get(&url, &mut progress)?;
        if !net::sha512_matches(&bytes, &l.sha512_b64) {
            return Err(
                "The downloaded release failed its checksum verification.\nThe connection may have been interrupted - try again.".into(),
            );
        }
        if l.size > 0 && bytes.len() as u64 != l.size {
            return Err("The downloaded release has an unexpected size.\nTry again in a moment.".into());
        }
        let _ = tx.send(Msg::Note("Unpacking the new version…".into()));
        Package::from_bytes(bytes)
    } else {
        Package::open()
            .ok_or("This copy of the installer is missing its files.\nPlease download Fleet again.")?
    };
    let entries = pkg.entries()?;
    let total: u64 = entries.iter().map(|e| e.raw_size).sum();

    if is_update {
        // Replace the previous version in place: close the running app, clear
        // the old files (nothing from the old version is left behind), then
        // extract the new payload over the same folder.
        let _ = tx.send(Msg::Note("Closing Fleet…".into()));
        shell::close_fleet_processes(dest);
        let _ = tx.send(Msg::Note("Removing the previous version…".into()));
        shell::wipe_dir(dest)?;
    }

    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Could not create the folder {}\n{e}", dest.display()))?;
    for exe in ["Fleet.exe", "node.exe", "uninstall.exe"] {
        shell::rotate_if_locked(&dest.join(exe))?;
    }
    shell::clean_rotated(dest);

    let _ = tx.send(Msg::Note("Copying files…".into()));
    let tx2 = tx.clone();
    pkg.extract(&entries, dest, |p| {
        let _ = tx2.send(Msg::Bytes(p.done_bytes, p.total_bytes));
        let _ = tx2.send(Msg::File(p.file.to_string()));
    })?;

    // Optional WebView2 runtime (bundled bootstrapper, silent). It runs from
    // the install folder - never from temp - and is removed either way.
    let bootstrapper = dest.join("WebView2Setup.exe");
    if !shell::webview2_installed() && bootstrapper.exists() {
        let _ = tx.send(Msg::Note("Setting up the WebView2 runtime - one time only…".into()));
        shell::install_webview2(&bootstrapper)?;
    }
    let _ = std::fs::remove_file(&bootstrapper);

    let _ = tx.send(Msg::Note("Finishing up…".into()));
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let exe = dest.join("Fleet.exe");
    let uninstall = dest.join("uninstall.exe");
    let est_kb = ((total + 1023) / 1024) as u32;
    shell::write_install_entries(dest, &exe, &uninstall, version, est_kb)?;

    let programs = shell::special_folder(CSIDL_PROGRAMS);
    if !programs.as_os_str().is_empty() {
        let sm_dir = programs.join("Fleet");
        let _ = std::fs::create_dir_all(&sm_dir);
        shell::create_shortcut(&sm_dir.join("Fleet.lnk"), &exe, dest, "Fleet - Roblox multi-instance launcher")?;
    }
    if desktop {
        let desktop_dir = shell::special_folder(CSIDL_DESKTOPDIRECTORY);
        if !desktop_dir.as_os_str().is_empty() {
            shell::create_shortcut(&desktop_dir.join("Fleet.lnk"), &exe, dest, "Fleet - Roblox multi-instance launcher")?;
        }
    }
    debug_log("run_install ok");
    Ok(())
}

fn run_uninstall(dir: &PathBuf, delete_data: bool, tx: &Sender<Msg>) -> Result<(), String> {
    debug_log("run_uninstall start");
    let _ = tx.send(Msg::Note("Removing shortcuts…".into()));

    let programs = shell::special_folder(CSIDL_PROGRAMS);
    if !programs.as_os_str().is_empty() {
        let _ = std::fs::remove_file(programs.join("Fleet\\Fleet.lnk"));
        let _ = std::fs::remove_dir(programs.join("Fleet"));
    }
    let desktop_dir = shell::special_folder(CSIDL_DESKTOPDIRECTORY);
    if !desktop_dir.as_os_str().is_empty() {
        let _ = std::fs::remove_file(desktop_dir.join("Fleet.lnk"));
    }

    shell::remove_install_entries();

    if delete_data {
        let _ = tx.send(Msg::Note("Removing saved data…".into()));
        for var in ["APPDATA", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
                let _ = std::fs::remove_dir_all(base.join("com.toluwa.fleet"));
            }
        }
    }

    let _ = tx.send(Msg::Note("Removing files…".into()));
    for exe in ["Fleet.exe", "node.exe"] {
        shell::rotate_if_locked(&dir.join(exe))?;
    }
    // Move ourselves out of the folder, then delete the folder.
    shell::self_delete();
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| {
            format!(
                "Some files in {} couldn't be removed.\nClose Fleet and run this again.\n\n{e}",
                dir.display()
            )
        })?;
    }
    debug_log("run_uninstall ok");
    Ok(())
}

// ------------------------------------------------------------------ window proc

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            let cs = &*(lparam.0 as *const CREATESTRUCTW);
            let hinst = windows::Win32::Foundation::HINSTANCE(cs.hInstance.0);
            let scale = {
                let dpi = GetDpiForWindow(hwnd);
                if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 }
            };

            let mut uninstall = false;
            let mut demo = false;
            let mut preset_path: Option<String> = None;
            for arg in std::env::args().skip(1) {
                let low = arg.to_ascii_lowercase();
                if low == "--uninstall" || low == "/uninstall" {
                    uninstall = true;
                } else if low == "--demo" {
                    demo = true;
                } else if let Some(p) = arg.strip_prefix("--path=") {
                    preset_path = Some(p.to_string());
                }
            }
            // A copy without a payload is the uninstaller.
            if !Package::exists() {
                uninstall = true;
            }

            let default_path = shell::local_app_data().join("Fleet").to_string_lossy().to_string();
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            // An existing install decides the whole flow: older version ->
            // update, same or newer -> up to date, nothing -> fresh install.
            let installed = if uninstall { None } else { shell::installed_fleet() };

            // The release feed check runs on its own thread while the page
            // settles; an old installer learns the newest version this way and
            // installs it instead of its embedded payload. Uninstall never
            // needs the network.
            let feed: Arc<Mutex<Option<Option<net::Latest>>>> =
                Arc::new(Mutex::new(None));
            let resolving = !uninstall;
            if resolving {
                let slot = Arc::clone(&feed);
                std::thread::spawn(move || {
                    let result = match net::fetch_latest() {
                        Ok(latest) => Some(Some(latest)),
                        Err(err) => {
                            debug_log(&format!("feed check failed: {err}"));
                            Some(None)
                        }
                    };
                    if let Ok(mut guard) = slot.lock() {
                        *guard = result;
                    }
                });
            }

            let updating = installed
                .as_ref()
                .map(|(_, v)| version_cmp(v, FLEET_VERSION) == std::cmp::Ordering::Less)
                .unwrap_or(false);

            // Uninstall mode always operates on the folder we live in
            // (the registry UninstallString points here). Updates always go
            // to the folder the existing Fleet lives in.
            let path = if uninstall {
                exe_dir
            } else if let Some((dir, _)) = &installed {
                dir.to_string_lossy().to_string()
            } else {
                preset_path.unwrap_or(default_path)
            };

            // On an update, keep the desktop shortcut only if one is already
            // there (the user's earlier choice); fresh installs offer it.
            let desktop_shortcut = if updating {
                let d = shell::special_folder(CSIDL_DESKTOPDIRECTORY);
                !d.as_os_str().is_empty() && d.join("Fleet.lnk").exists()
            } else {
                true
            };

            let fonts = Fonts {
                display: make_font(w!("Segoe UI Variable Display"), 600, 24, scale),
                head: make_font(w!("Segoe UI Variable Display"), 600, 17, scale),
                body: make_font(w!("Segoe UI Variable Text"), 400, 13, scale),
                path: make_font(w!("Segoe UI Variable Text"), 400, 14, scale),
                small: make_font(w!("Segoe UI Variable Text"), 400, 12, scale),
            };
            let mut app = Box::new(App {
                hwnd,
                hinst,
                brush: CreateSolidBrush(COLORREF(BG)),
                hair_brush: CreateSolidBrush(COLORREF(HAIR)),
                fonts,
                scale,
                uninstall_mode: uninstall,
                demo,
                stage: if uninstall {
                    Stage::UninstallConfirm
                } else if installed.is_some() {
                    Stage::Resolve
                } else {
                    Stage::Fresh
                },
                ctrls: Vec::new(),
                alpha: 0,
                path,
                desktop_shortcut,
                delete_data: false,
                last_error: String::new(),
                install_dest: PathBuf::new(),
                rx: None,
                busy: false,
                fade: Fade { active: false, from: 0, to: 255, t0: 0, dur: 1, after: After::None },
                installed,
                updating,
                latest: None,
                feed,
                resolve_deadline: 0,
                resolving,
                sweep: 0,
                hlogo: None,
            });
            load_logo(&mut app);
            let raw = Box::into_raw(app);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, raw as isize);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_CREATE => {
            if let Some(a) = app_from(hwnd) {
                size_window(a);
                // Match the caption to the dark client area.
                dark_titlebar(hwnd);
                // Start fully transparent; the first fade brings the window in.
                // (Controls are created after the window is visible - wine
                // otherwise never paints children made on a hidden window.)
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);
            }
            LRESULT(0)
        }

        WM_TIMER => {
            if let Some(a) = app_from(hwnd) {
                match wparam.0 {
                    IDT_FADE => step_fade(a),
                    IDT_DEMO => {
                        let _ = KillTimer(Some(hwnd), IDT_DEMO);
                        demo_advance(a);
                    }
                    IDT_POLL => poll_worker(a),
                    IDT_RESOLVE => poll_resolve(a),
                    IDT_SWEEP => {
                        // Indeterminate uninstall progress: a calm sweep.
                        a.sweep += 2;
                        if a.sweep > 100 {
                            a.sweep = 0;
                        }
                        set_progress(a, a.sweep.max(0) as u64, 100);
                    }
                    _ => {}
                }
            }
            LRESULT(0)
        }

        WM_COMMAND => {
            if let Some(a) = app_from(hwnd) {
                let hi = ((wparam.0 >> 16) & 0xffff) as u32;
                let id = (wparam.0 & 0xffff) as i32;
                if hi == BN_CLICKED {
                    on_button(a, id);
                } else if hi == 0x0003 && id == IDC_PATHEDIT {
                    // EN_CHANGE: remember the path and clear any inline error.
                    if let Some(ctl) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_PATHEDIT) {
                        let text = window_text(*ctl);
                        if !text.is_empty() {
                            a.path = text;
                        }
                    }
                    if let Some(err) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_ERROR) {
                        if IsWindowVisible(*err).as_bool() {
                            let _ = ShowWindow(*err, SW_HIDE);
                        }
                    }
                }
            }
            LRESULT(0)
        }

        WM_CTLCOLORSTATIC => {
            if let Some(a) = app_from(hwnd) {
                let hdc = HDC(wparam.0 as *mut core::ffi::c_void);
                let ctl = HWND(lparam.0 as *mut core::ffi::c_void);
                let id = GetDlgCtrlID(ctl);
                let color = match id {
                    IDC_HEAD => INK,
                    IDC_PATH => INK,
                    IDC_SUB | IDC_LABEL => INK_2,
                    IDC_ERROR => DANGER,
                    _ => INK_3, // hint, bytes, file, tagline, version
                };
                SetTextColor(hdc, COLORREF(color));
                if id == IDC_RULE {
                    // The 1px hairline: an empty static filled with the brush.
                    SetBkColor(hdc, COLORREF(HAIR));
                    return LRESULT(a.hair_brush.0 as isize);
                }
                SetBkColor(hdc, COLORREF(BG));
                SetBkMode(hdc, TRANSPARENT);
                return LRESULT(a.brush.0 as isize);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_CTLCOLOREDIT => {
            if let Some(a) = app_from(hwnd) {
                let hdc = HDC(wparam.0 as *mut core::ffi::c_void);
                SetTextColor(hdc, COLORREF(INK));
                SetBkColor(hdc, COLORREF(BG));
                return LRESULT(a.brush.0 as isize);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_CLOSE => {
            if let Some(a) = app_from(hwnd) {
                if a.busy {
                    let text = if a.uninstall_mode {
                        "Fleet isn't finished removing itself yet.\nQuit anyway?"
                    } else if a.updating {
                        "Fleet isn't finished updating yet.\nQuit anyway?"
                    } else {
                        "Fleet isn't finished installing yet.\nQuit anyway?"
                    };
                    let title = if a.uninstall_mode { UNINSTALL_TITLE } else { APP_TITLE };
                    let r = MessageBoxW(
                        Some(hwnd),
                        PCWSTR(to_wide(text).as_ptr()),
                        PCWSTR(to_wide(title).as_ptr()),
                        MB_OKCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2,
                    );
                    if r == IDOK {
                        PostQuitMessage(0);
                    }
                } else {
                    fade_quit(a);
                }
            }
            LRESULT(0)
        }

        WM_DPICHANGED => {
            if let Some(a) = app_from(hwnd) {
                let new_dpi = ((wparam.0 >> 16) & 0xffff) as u32;
                a.scale = if new_dpi == 0 { 1.0 } else { new_dpi as f32 / 96.0 };
                let suggested = &*(lparam.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    suggested.left,
                    suggested.top,
                    suggested.right - suggested.left,
                    suggested.bottom - suggested.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                rebuild_fonts(a);
                load_logo(a);
                build_stage(a);
            }
            LRESULT(0)
        }

        WM_NCDESTROY => {
            let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if raw != 0 {
                let mut app = Box::from_raw(raw as *mut App);
                if let Some(h) = app.hlogo.take() {
                    unsafe { let _ = DestroyIcon(HICON(h.0)); }
                }
                drop(app);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            let r = DefWindowProcW(hwnd, msg, wparam, lparam);
            // The graceful exit path (fade_quit -> DestroyWindow) never posted
            // WM_QUIT, so the GetMessageW pump blocked forever and the process
            // lingered as a zombie after its window closed. This proc only
            // serves the main window, so this runs exactly once per process.
            PostQuitMessage(0);
            r
        }

        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ------------------------------------------------------------------ app plumbing

fn app_from(hwnd: HWND) -> Option<&'static mut App> {
    unsafe {
        let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        if raw == 0 {
            None
        } else {
            Some(&mut *(raw as *mut App))
        }
    }
}

fn window_text(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd) as usize;
        let mut buf = vec![0u16; len + 1];
        let got = GetWindowTextW(hwnd, &mut buf) as usize;
        let n = got.min(len);
        String::from_utf16_lossy(&buf[..n])
    }
}

fn size_window(a: &App) {
    unsafe {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: (WIN_W as f32 * a.scale) as i32,
            bottom: (WIN_H as f32 * a.scale) as i32,
        };
        let style = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
        let _ = AdjustWindowRect(&mut rect, style, false);

        let w = (rect.right - rect.left).max(1);
        let h = (rect.bottom - rect.top).max(1);

        let mut work = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let got = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work as *mut RECT as *mut core::ffi::c_void),
            Default::default(),
        )
        .is_ok();
        let (x, y) = if got && work.right > work.left {
            (work.left + (work.right - work.left - w) / 2, work.top + (work.bottom - work.top - h) / 2)
        } else {
            (CW_USEDEFAULT, CW_USEDEFAULT)
        };
        let _ = SetWindowPos(a.hwnd, Some(HWND_TOP), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

fn rebuild_fonts(a: &mut App) {
    let s = a.scale;
    unsafe {
        let _ = DeleteObject(HGDIOBJ(a.fonts.display.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.head.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.body.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.path.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.small.0));
    }
    a.fonts = Fonts {
        display: make_font(w!("Segoe UI Variable Display"), 600, 24, s),
        head: make_font(w!("Segoe UI Variable Display"), 600, 17, s),
        body: make_font(w!("Segoe UI Variable Text"), 400, 13, s),
        path: make_font(w!("Segoe UI Variable Text"), 400, 14, s),
        small: make_font(w!("Segoe UI Variable Text"), 400, 12, s),
    };
}

fn start_fade(a: &mut App, to: u8, dur: u32, after: After) {
    a.fade = Fade {
        active: true,
        from: a.alpha,
        to,
        t0: unsafe { GetTickCount64() },
        dur,
        after,
    };
    unsafe {
        let _ = SetTimer(Some(a.hwnd), IDT_FADE, 16, None);
        step_fade(a);
    }
}

unsafe fn step_fade(a: &mut App) {
    if !a.fade.active {
        let _ = KillTimer(Some(a.hwnd), IDT_FADE);
        return;
    }
    let now = GetTickCount64();
    let t = ((now - a.fade.t0) as f32 / a.fade.dur.max(1) as f32).clamp(0.0, 1.0);
    let eased = t * t * (3.0 - 2.0 * t);
    let alpha = (a.fade.from as f32 + (a.fade.to as f32 - a.fade.from as f32) * eased)
        .clamp(0.0, 255.0) as u8;
    a.alpha = alpha;
    let _ = SetLayeredWindowAttributes(a.hwnd, COLORREF(0), alpha, LWA_ALPHA);
    if t >= 1.0 {
        let after = std::mem::replace(&mut a.fade.after, After::None);
        a.fade.active = false;
        let _ = KillTimer(Some(a.hwnd), IDT_FADE);
        // A layered window whose alpha changed may never repaint on its own
        // (wine in particular), so force a full synchronous repaint whenever
        // we settle at full opacity.
        if a.alpha == 255 {
            force_repaint(a);
        }
        if let After::Quit = after {
            let _ = DestroyWindow(a.hwnd);
        }
    }
}

fn force_repaint(a: &App) {
    unsafe {
        windows::Win32::Graphics::Gdi::RedrawWindow(
            Some(a.hwnd),
            None,
            None,
            windows::Win32::Graphics::Gdi::RDW_INVALIDATE
                | windows::Win32::Graphics::Gdi::RDW_ERASE
                | windows::Win32::Graphics::Gdi::RDW_ALLCHILDREN
                | windows::Win32::Graphics::Gdi::RDW_UPDATENOW,
        );
    }
}

/// One page, no wizard: state changes rebuild the content area in place.
/// The header never moves; only the window open/close fades exist.
fn goto_stage(a: &mut App, next: Stage) {
    a.stage = next;
    build_stage(a);
    force_repaint(a);
}

/// The first real page once the feed resolves: fresh install keeps the form,
/// an older install updates, a same/newer install is told it's up to date.
fn first_stage(a: &App) -> Stage {
    let effective = a.version_to_install();
    match &a.installed {
        None => Stage::Fresh,
        Some((_, v)) => {
            if version_cmp(v, &effective) == std::cmp::Ordering::Less {
                Stage::UpdateReady
            } else {
                Stage::UpToDate
            }
        }
    }
}

/// Waits (bounded) for the release-feed thread, then decides the real first
/// page against the version that will actually be installed.
fn start_resolve(a: &mut App) {
    a.resolve_deadline = unsafe { GetTickCount64() } + 6000;
    poll_resolve(a);
}

fn poll_resolve(a: &mut App) {
    let resolved = a.feed.lock().ok().and_then(|guard| guard.clone());
    match resolved {
        None => {
            let now = unsafe { GetTickCount64() };
            if now >= a.resolve_deadline {
                // The feed is too slow; proceed offline (embedded payload).
                debug_log("feed check timed out - installing the embedded payload");
                if let Ok(mut guard) = a.feed.lock() {
                    *guard = Some(None);
                }
                finish_resolve(a);
            } else {
                unsafe {
                    let _ = SetTimer(Some(a.hwnd), IDT_RESOLVE, 100, None);
                }
            }
        }
        Some(_) => finish_resolve(a),
    }
}

fn finish_resolve(a: &mut App) {
    unsafe {
        let _ = KillTimer(Some(a.hwnd), IDT_RESOLVE);
    }
    if let Ok(guard) = a.feed.lock() {
        if let Some(inner) = guard.clone() {
            a.latest = inner;
        }
    }
    if let Some(latest) = &a.latest {
        debug_log(&format!(
            "feed: latest is v{} (embedded: v{FLEET_VERSION})",
            latest.version
        ));
    }
    a.resolving = false;
    // "Updating" is decided against the version that will be installed - the
    // newer of the embedded payload and the release feed.
    let effective = a.version_to_install();
    a.updating = a
        .installed
        .as_ref()
        .map(|(_, v)| version_cmp(v, &effective) == std::cmp::Ordering::Less)
        .unwrap_or(false);
    match a.stage {
        Stage::Resolve => goto_stage(a, first_stage(a)),
        // The form was already up; rebuild it so Install enables and the
        // version line reflects whatever the feed offered.
        Stage::Fresh => goto_stage(a, Stage::Fresh),
        _ => {}
    }
}

impl App {
    /// The version this run installs: the newest of the embedded payload and
    /// the GitHub release feed (when the feed is unreachable or older, the
    /// embedded payload is what exists on disk, so it wins).
    fn version_to_install(&self) -> String {
        match &self.latest {
            Some(l) if version_cmp(&l.version, FLEET_VERSION) == std::cmp::Ordering::Greater => {
                l.version.clone()
            }
            _ => FLEET_VERSION.to_string(),
        }
    }
}

fn fade_quit(a: &mut App) {
    start_fade(a, 0, 180, After::Quit);
}

// ------------------------------------------------------------------ stage UI

struct CtrlSpec<'a> {
    class: PCWSTR,
    text: &'a str,
    style: u32,
    ex: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    id: i32,
    font: Option<HFONT>,
}

fn add_ctrl(a: &mut App, spec: CtrlSpec) -> HWND {
    unsafe {
        let s = a.scale;
        let hwnd = windows::Win32::UI::WindowsAndMessaging::CreateWindowExW(
            WINDOW_EX_STYLE(spec.ex),
            spec.class,
            PCWSTR(to_wide(spec.text).as_ptr()),
            WINDOW_STYLE(spec.style),
            (spec.x as f32 * s) as i32,
            (spec.y as f32 * s) as i32,
            (spec.w as f32 * s) as i32,
            (spec.h as f32 * s) as i32,
            Some(a.hwnd),
            Some(HMENU(spec.id as usize as *mut core::ffi::c_void)),
            Some(a.hinst),
            None,
        )
        .unwrap_or(HWND(std::ptr::null_mut()));
        if let Some(f) = spec.font {
            let _ = SendMessageW(hwnd, WM_SETFONT, Some(WPARAM(f.0 as usize)), Some(LPARAM(1)));
        }
        a.ctrls.push(hwnd);
        hwnd
    }
}

fn build_stage(a: &mut App) {
    unsafe {
        for c in &a.ctrls {
            let _ = DestroyWindow(*c);
        }
        a.ctrls.clear();
        let _ = KillTimer(Some(a.hwnd), IDT_SWEEP);

        const VISIBLE: u32 = 0x5000_0000; // WS_CHILD | WS_VISIBLE
        const TABSTOP: u32 = 0x0001_0000;
        const SS_NOP: u32 = 0x80; // SS_NOPREFIX
        // Copy the fonts out so the macros below never hold a borrow.
        let f = a.fonts;

        macro_rules! static_text {
            ($a:expr, $text:expr, $style:expr, $font:expr, $x:expr, $y:expr, $w:expr, $h:expr, $id:expr) => {
                add_ctrl(
                    $a,
                    CtrlSpec {
                        class: w!("STATIC"),
                        text: $text,
                        style: VISIBLE | SS_NOP | $style,
                        ex: 0,
                        x: $x,
                        y: $y,
                        w: $w,
                        h: $h,
                        id: $id,
                        font: $font,
                    },
                )
            };
        }
        macro_rules! button {
            ($a:expr, $text:expr, $extra:expr, $x:expr, $y:expr, $w:expr, $h:expr, $id:expr, $font:expr) => {{
                let h = add_ctrl(
                    $a,
                    CtrlSpec {
                        class: w!("BUTTON"),
                        text: $text,
                        style: VISIBLE | TABSTOP | $extra,
                        ex: 0,
                        x: $x,
                        y: $y,
                        w: $w,
                        h: $h,
                        id: $id,
                        font: Some($font),
                    },
                );
                dark_control(h);
                h
            }};
        }
        macro_rules! checkbox {
            ($a:expr, $text:expr, $x:expr, $y:expr, $w:expr, $h:expr, $id:expr, $font:expr) => {
                button!($a, $text, 0x3, $x, $y, $w, $h, $id, $font)
            };
        }
        macro_rules! rule {
            ($a:expr, $y:expr) => {
                // A 1px hairline: an empty static filled with the hair brush.
                add_ctrl(
                    $a,
                    CtrlSpec {
                        class: w!("STATIC"),
                        text: "",
                        style: VISIBLE,
                        ex: 0,
                        x: 36,
                        y: $y,
                        w: 448,
                        h: 1,
                        id: IDC_RULE,
                        font: None,
                    },
                )
            };
        }
        macro_rules! footer {
            ($a:expr, $hint:expr, $secondary:expr, $primary_label:expr, $primary_id:expr) => {{
                rule!($a, 288);
                if let Some((label, id)) = $secondary {
                    button!($a, label, 0, 224, 304, 128, 32, id, f.body);
                }
                button!($a, $primary_label, 0x1, 368, 304, 116, 32, $primary_id, f.body);
                if !$hint.is_empty() {
                    // Hints only appear on stages without a secondary button,
                    // so the label can run wide up to the primary button.
                    static_text!($a, $hint, 0, Some(f.small), 36, 311, 320, 18, IDC_HINT);
                }
            }};
        }
        macro_rules! flat_progress {
            ($a:expr, $y:expr) => {{
                let prog = add_ctrl(
                    $a,
                    CtrlSpec {
                        class: w!("msctls_progress32"),
                        text: "",
                        style: VISIBLE | 0x01, // PBS_SMOOTH
                        ex: 0,
                        x: 36,
                        y: $y,
                        w: 448,
                        h: 8,
                        id: 0,
                        font: None,
                    },
                );
                // Detach from the visual style (BOTH strings empty - a NULL
                // sub id list leaves the theme attached) so the color messages
                // apply: a flat Fleet-blue fill on a dark track, like the app's
                // own bars. PBM_SETBKCOLOR is CCM_SETBKCOLOR (0x2001).
                let _ = SetWindowTheme(prog, w!(""), w!(""));
                let _ = SendMessageW(prog, PBM_SETRANGE32, Some(WPARAM(0)), Some(LPARAM(10000)));
                let _ = SendMessageW(prog, PBM_SETBKCOLOR, Some(WPARAM(0)), Some(LPARAM(TRACK as isize)));
                let _ = SendMessageW(prog, PBM_SETBARCOLOR, Some(WPARAM(0)), Some(LPARAM(ACCENT as isize)));
                prog
            }};
        }

        // ---- the fixed header: logo, wordmark, tagline, version ----------
        let logo = add_ctrl(
            a,
            CtrlSpec {
                class: w!("STATIC"),
                text: "",
                style: VISIBLE | 0x3, // SS_ICON
                ex: 0,
                x: 36,
                y: 30,
                w: 48,
                h: 48,
                id: 0,
                font: None,
            },
        );
        if let Some(h) = a.hlogo {
            let _ = SendMessageW(
                logo,
                STM_SETIMAGE,
                Some(WPARAM(IMAGE_ICON.0 as usize)),
                Some(LPARAM(h.0 as isize)),
            );
        }
        static_text!(a, "Fleet", 0, Some(f.display), 98, 26, 300, 34, IDC_HEAD);
        static_text!(a, "Multi-instance Roblox launcher", 0, Some(f.small), 98, 62, 320, 18, IDC_TAG);
        let version_line = format!("v{}", a.version_to_install());
        static_text!(a, &version_line, 0x2, Some(f.small), 324, 34, 160, 18, IDC_VERSION); // SS_RIGHT
        rule!(a, 96);

        // ---- the content area: one page per state ------------------------
        match a.stage {
            Stage::Resolve => {
                static_text!(
                    a,
                    "Checking for the latest version…",
                    0x1, // SS_CENTER
                    Some(f.small),
                    36, 150, 448, 20, IDC_SUB
                );
            }

            Stage::Fresh => {
                let path_text = a.path.clone();
                static_text!(a, "Install folder", 0, Some(f.small), 36, 114, 448, 18, IDC_LABEL);

                let edit = add_ctrl(
                    a,
                    CtrlSpec {
                        class: w!("EDIT"),
                        text: &path_text,
                        style: VISIBLE | TABSTOP | 0x80, // ES_AUTOHSCROLL
                        ex: WS_EX_CLIENTEDGE.0,
                        x: 36,
                        y: 138,
                        w: 316,
                        h: 30,
                        id: IDC_PATHEDIT,
                        font: Some(f.path),
                    },
                );
                dark_control(edit);
                let _ = SendMessageW(edit, 0x00D5, Some(WPARAM(1024)), Some(LPARAM(0))); // EM_LIMITTEXT

                button!(a, "Browse…", 0, 364, 138, 120, 30, IDC_BROWSE, f.body);

                let err = static_text!(a, "", 0, Some(f.small), 36, 176, 448, 18, IDC_ERROR);
                let _ = ShowWindow(err, SW_HIDE);

                let ck = checkbox!(a, "Add a desktop shortcut", 36, 212, 320, 24, IDC_CHECK_DESKTOP, f.body);
                let st = if a.desktop_shortcut { windows::Win32::UI::Controls::BST_CHECKED.0 as usize } else { 0 };
                let _ = SendMessageW(ck, BM_SETCHECK, Some(WPARAM(st)), Some(LPARAM(0)));

                // While the release feed is still resolving, Install waits so
                // nobody installs a stale payload seconds before the check
                // would have handed out the newest one.
                let hint = if a.resolving {
                    "Checking for the latest version…"
                } else {
                    "Installs for you - no admin needed."
                };
                if a.resolving {
                    footer!(a, hint, None, "Install Fleet", IDC_INSTALL);
                    if let Some(ctl) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_INSTALL) {
                        let _ = EnableWindow(*ctl, false);
                    }
                } else {
                    footer!(a, hint, None, "Install Fleet", IDC_INSTALL);
                }
                focus_ctrl(a, IDC_PATHEDIT);
            }

            Stage::UpdateReady => {
                let old = a
                    .installed
                    .as_ref()
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                let new_version = a.version_to_install();
                let sub = if old.is_empty() {
                    format!("Fleet will be updated to v{new_version}.")
                } else {
                    format!("Fleet v{old} will be updated to v{new_version}.")
                };
                let path_text = a.path.clone();
                static_text!(a, "Update available", 0, Some(f.head), 36, 114, 448, 26, IDC_HEAD);
                static_text!(a, &sub, 0, Some(f.body), 36, 144, 448, 20, IDC_SUB);
                static_text!(a, &path_text, 0x4000, Some(f.path), 36, 168, 448, 20, IDC_PATH);
                static_text!(
                    a,
                    "Fleet will close while it updates - your accounts and settings stay where they are.",
                    0x2000, // SS_EDITCONTROL (wraps)
                    Some(f.small),
                    36, 198, 448, 36, IDC_HINT
                );
                footer!(a, "Same folder, in place.", None, "Update Fleet", IDC_INSTALL);
                focus_ctrl(a, IDC_INSTALL);
            }

            Stage::UpToDate => {
                let cur = a
                    .installed
                    .as_ref()
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                let eff = a.version_to_install();
                // cur > eff can only happen when the feed was unreachable
                // AND a newer Fleet than this installer is installed.
                let sub = if version_cmp(&cur, &eff) == std::cmp::Ordering::Equal {
                    format!("The latest version (v{eff}) is already installed.")
                } else {
                    format!("A newer version (v{cur}) is already installed.")
                };
                static_text!(a, "Fleet is up to date.", 0, Some(f.head), 36, 126, 448, 26, IDC_HEAD);
                static_text!(a, &sub, 0, Some(f.body), 36, 156, 448, 20, IDC_SUB);
                static_text!(
                    a,
                    "This installer checks GitHub for the newest release, so an old download still installs the latest Fleet.",
                    0x2000,
                    Some(f.small),
                    36, 184, 448, 36, IDC_HINT
                );
                let secondary = if version_cmp(&cur, &eff) == std::cmp::Ordering::Greater {
                    Some(("Get newer version", IDC_RELEASES))
                } else {
                    None
                };
                footer!(a, "", secondary, "Close", IDC_CLOSE);
                focus_ctrl(a, IDC_CLOSE);
            }

            Stage::Installing => {
                let (head, note) = if a.updating {
                    ("Updating Fleet…", "Closing Fleet…")
                } else {
                    ("Installing Fleet…", "Copying files…")
                };
                static_text!(a, head, 0, Some(f.head), 36, 118, 448, 26, IDC_HEAD);
                static_text!(a, note, 0, Some(f.body), 36, 148, 448, 20, IDC_SUB);

                flat_progress!(a, 178);

                static_text!(a, "", 0, Some(f.small), 36, 198, 448, 16, IDC_BYTES);
                static_text!(a, "", 0x4000, Some(f.small), 36, 218, 448, 16, IDC_FILE);
            }

            Stage::Done => {
                let dest_text = a.install_dest.to_string_lossy().to_string();
                let installed_version = a.version_to_install();
                let (head, sub) = if a.updating {
                    (
                        "Fleet is updated.",
                        format!("You're on the latest version - v{installed_version}."),
                    )
                } else {
                    ("Fleet is installed.", "Launch it whenever you're ready.".to_string())
                };
                static_text!(a, head, 0, Some(f.head), 36, 118, 448, 26, IDC_HEAD);
                static_text!(a, &sub, 0, Some(f.body), 36, 148, 448, 20, IDC_SUB);
                static_text!(a, &dest_text, 0x4000, Some(f.small), 36, 172, 448, 18, IDC_HINT);

                footer!(a, "", Some(("Close", IDC_CLOSE)), "Launch Fleet", IDC_LAUNCH);
                focus_ctrl(a, IDC_LAUNCH);
            }

            Stage::Error => {
                let err_text = a.last_error.clone();
                static_text!(a, "That didn't work.", 0, Some(f.head), 36, 114, 448, 26, IDC_HEAD);
                static_text!(a, &err_text, 0x2000, Some(f.body), 36, 144, 448, 120, IDC_SUB);

                footer!(a, "", Some(("Close", IDC_CLOSE)), "Try again", IDC_RETRY);
                focus_ctrl(a, IDC_RETRY);
            }

            Stage::UninstallConfirm => {
                static_text!(a, "Remove Fleet?", 0, Some(f.head), 36, 118, 448, 26, IDC_HEAD);
                static_text!(
                    a,
                    "This removes Fleet's program files from your PC. Your saved accounts and settings stay where they are.",
                    0x2000,
                    Some(f.body),
                    36, 148, 448, 40, IDC_SUB
                );

                let ck = checkbox!(a, "Also delete accounts and settings", 36, 206, 340, 24, IDC_CHECK_DATA, f.body);
                let st = if a.delete_data { windows::Win32::UI::Controls::BST_CHECKED.0 as usize } else { 0 };
                let _ = SendMessageW(ck, BM_SETCHECK, Some(WPARAM(st)), Some(LPARAM(0)));

                footer!(a, "", Some(("Cancel", IDC_CANCEL)), "Remove", IDC_REMOVE);
                focus_ctrl(a, IDC_REMOVE);
            }

            Stage::Uninstalling => {
                static_text!(a, "Removing Fleet…", 0, Some(f.head), 36, 118, 448, 26, IDC_HEAD);
                static_text!(a, "Removing files…", 0, Some(f.body), 36, 148, 448, 20, IDC_SUB);

                flat_progress!(a, 178);
                let _ = SetTimer(Some(a.hwnd), IDT_SWEEP, 30, None);
            }

            Stage::Uninstalled => {
                static_text!(a, "Fleet is gone.", 0, Some(f.head), 36, 126, 448, 26, IDC_HEAD);
                static_text!(
                    a,
                    "All of Fleet's program files were removed.",
                    0x2000,
                    Some(f.body),
                    36, 156, 448, 40, IDC_SUB
                );

                footer!(a, "", None, "Close", IDC_CLOSE);
                focus_ctrl(a, IDC_CLOSE);
            }
        }

        if a.demo {
            let delay: u32 = match a.stage {
                Stage::Fresh => 2200,
                Stage::UpdateReady => 2000,
                Stage::UpToDate => 2500,
                Stage::Done => 3000,
                Stage::UninstallConfirm => 2000,
                Stage::Uninstalled => 2500,
                _ => 0,
            };
            if delay > 0 {
                let _ = SetTimer(Some(a.hwnd), IDT_DEMO, delay, None);
            }
        }
    }
}

fn focus_ctrl(a: &App, id: i32) {
    unsafe {
        if let Some(ctl) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == id) {
            let _ = SetFocus(Some(*ctl));
        }
    }
}

// ------------------------------------------------------------------ actions

fn on_button(a: &mut App, id: i32) {
    debug_log(&format!("button clicked: id={id} stage={:?}", a.stage));
    match id {
        IDC_BROWSE => {
            let start = PathBuf::from(a.path.clone());
            let picked = shell::pick_folder(a.hwnd, "Choose a folder for Fleet", &start);
            if let Some(dir) = picked {
                a.path = dir.to_string_lossy().to_string();
                unsafe {
                    if let Some(ctl) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_PATHEDIT) {
                        let _ = SetWindowTextW(*ctl, PCWSTR(to_wide(&a.path).as_ptr()));
                    }
                    if let Some(err) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_ERROR) {
                        let _ = ShowWindow(*err, SW_HIDE);
                    }
                }
            }
        }
        IDC_INSTALL | IDC_RETRY => {
            // The one-page form validates inline: no separate confirm page.
            if a.stage == Stage::Fresh {
                match validate_path(&a.path) {
                    Ok(clean) => a.path = clean,
                    Err(msg) => unsafe {
                        if let Some(err) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_ERROR) {
                            let _ = SetWindowTextW(*err, PCWSTR(to_wide(msg).as_ptr()));
                            let _ = ShowWindow(*err, SW_SHOW);
                        }
                        return;
                    },
                }
            }
            a.install_dest = PathBuf::from(a.path.clone());
            start_install(a);
            goto_stage(a, Stage::Installing);
        }
        IDC_LAUNCH => {
            let exe = a.install_dest.join("Fleet.exe");
            let dir = a.install_dest.clone();
            shell::launch_app(&exe, &dir);
            fade_quit(a);
        }
        IDC_CLOSE | IDC_CANCEL => unsafe {
            let _ = PostMessageW(Some(a.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        },
        IDC_RELEASES => {
            if !shell::open_url("https://github.com/Toluwer/Fleet/releases") {
                unsafe {
                    let text = "The page could not open automatically.\nIt lives at github.com/Toluwer/Fleet/releases.";
                    let _ = MessageBoxW(
                        Some(a.hwnd),
                        PCWSTR(to_wide(text).as_ptr()),
                        PCWSTR(to_wide(APP_TITLE).as_ptr()),
                        MB_OKCANCEL | windows::Win32::UI::WindowsAndMessaging::MB_ICONINFORMATION,
                    );
                }
            }
        },
        IDC_CHECK_DESKTOP => unsafe {
            if let Some(ck) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_CHECK_DESKTOP) {
                let st = SendMessageW(*ck, BM_GETCHECK, Some(WPARAM(0)), Some(LPARAM(0))).0;
                a.desktop_shortcut = st == windows::Win32::UI::Controls::BST_CHECKED.0 as isize;
            }
        },
        IDC_CHECK_DATA => unsafe {
            if let Some(ck) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_CHECK_DATA) {
                let st = SendMessageW(*ck, BM_GETCHECK, Some(WPARAM(0)), Some(LPARAM(0))).0;
                a.delete_data = st == windows::Win32::UI::Controls::BST_CHECKED.0 as isize;
            }
        },
        IDC_REMOVE => {
            if a.uninstall_mode {
                // The uninstaller removes the folder it lives in.
                let d = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_default();
                a.path = d.to_string_lossy().to_string();
            }
            start_uninstall(a);
            goto_stage(a, Stage::Uninstalling);
        }
        _ => {}
    }
}

fn demo_advance(a: &mut App) {
    match a.stage {
        Stage::Fresh => {
            if a.resolving {
                // The feed check is still in flight; retry shortly so the
                // demo never installs a stale payload mid-check.
                unsafe {
                    let _ = SetTimer(Some(a.hwnd), IDT_DEMO, 600, None);
                }
            } else {
                on_button(a, IDC_INSTALL);
            }
        }
        Stage::UpdateReady => on_button(a, IDC_INSTALL),
        Stage::UpToDate | Stage::Done | Stage::Uninstalled => fade_quit(a),
        Stage::UninstallConfirm => on_button(a, IDC_REMOVE),
        _ => {}
    }
}

// ------------------------------------------------------------------ worker plumbing

fn start_install(a: &mut App) {
    let dest = a.install_dest.clone();
    let desktop = a.desktop_shortcut;
    let version = a.version_to_install();
    let is_update = a.updating;
    let latest = a.latest.clone();
    let (tx, rx) = channel::<Msg>();
    a.rx = Some(rx);
    a.busy = true;
    unsafe {
        let _ = SetTimer(Some(a.hwnd), IDT_POLL, 40, None);
    }
    std::thread::spawn(move || {
        match run_install(&dest, desktop, &version, is_update, latest, &tx) {
            Ok(()) => {
                let _ = tx.send(Msg::Done);
            }
            Err(e) => {
                debug_log(&format!("install error: {e}"));
                let _ = tx.send(Msg::Err(e));
            }
        }
    });
}

fn start_uninstall(a: &mut App) {
    let dir = PathBuf::from(a.path.clone());
    let delete_data = a.delete_data;
    let (tx, rx) = channel::<Msg>();
    a.rx = Some(rx);
    a.busy = true;
    unsafe {
        let _ = SetTimer(Some(a.hwnd), IDT_POLL, 40, None);
    }
    std::thread::spawn(move || match run_uninstall(&dir, delete_data, &tx) {
        Ok(()) => {
            let _ = tx.send(Msg::Done);
        }
        Err(e) => {
            debug_log(&format!("uninstall error: {e}"));
            let _ = tx.send(Msg::Err(e));
        }
    });
}

fn poll_worker(a: &mut App) {
    let Some(rx) = a.rx.take() else { return };
    let mut finished: Option<Msg> = None;
    while let Ok(m) = rx.try_recv() {
        match m {
            Msg::File(f) => set_ctrl_text(a, IDC_FILE, &f),
            Msg::Bytes(done, total) => {
                set_progress(a, done, total);
                set_ctrl_text(a, IDC_BYTES, &format!("{} of {}", mb(done), mb(total)));
            }
            Msg::Note(n) => set_ctrl_text(a, IDC_SUB, &n),
            Msg::Done => finished = Some(Msg::Done),
            Msg::Err(e) => finished = Some(Msg::Err(e)),
        }
    }
    match finished {
        Some(Msg::Done) | Some(Msg::Err(_)) => {
            let was_error = matches!(finished, Some(Msg::Err(_)));
            unsafe {
                let _ = KillTimer(Some(a.hwnd), IDT_POLL);
            }
            a.busy = false;
            if was_error {
                if let Some(Msg::Err(e)) = finished {
                    a.last_error = e;
                }
                goto_stage(a, Stage::Error);
            } else {
                let next = if a.uninstall_mode { Stage::Uninstalled } else { Stage::Done };
                goto_stage(a, next);
            }
        }
        _ => {
            a.rx = Some(rx); // still busy
        }
    }
}

fn set_ctrl_text(a: &App, id: i32, text: &str) {
    unsafe {
        if let Some(ctl) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == id) {
            let _ = SetWindowTextW(*ctl, PCWSTR(to_wide(text).as_ptr()));
        }
    }
}

fn set_progress(a: &App, done: u64, total: u64) {
    unsafe {
        for ctl in a.ctrls.iter() {
            let mut cls = [0u16; 32];
            let n = GetClassNameW(*ctl, &mut cls);
            if String::from_utf16_lossy(&cls[..n.max(0) as usize]) != "msctls_progress32" {
                continue;
            }
            let pos = if total == 0 {
                10000
            } else {
                ((done as f64 / total as f64) * 10000.0).round() as usize
            };
            let _ = SendMessageW(*ctl, PBM_SETPOS, Some(WPARAM(pos)), Some(LPARAM(0)));
        }
    }
}

// ------------------------------------------------------------------ entry

fn main() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        let hinst: HINSTANCE = GetModuleHandleW(None).expect("module handle").into();
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // Progress bars live in the common controls library.
        let icc = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: windows::Win32::UI::Controls::INITCOMMONCONTROLSEX_ICC(0x20 | 0x01), // ICC_PROGRESS_CLASSES | ICC_WIN95_CLASSES
        };
        let _ = InitCommonControlsEx(&icc);

        let wc = WNDCLASSW {
            style: Default::default(),
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: LoadIconW(Some(hinst), PCWSTR(1 as *const u16))
                .or_else(|_| LoadIconW(None, IDI_APPLICATION))
                .unwrap_or(windows::Win32::UI::WindowsAndMessaging::HICON(std::ptr::null_mut())),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: CreateSolidBrush(COLORREF(BG)),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: w!("FleetSetupWindow"),
        };
        let _ = RegisterClassW(&wc);

        // The window title depends on the mode.
        let uninstall = std::env::args().skip(1).any(|arg| {
            let l = arg.to_ascii_lowercase();
            l == "--uninstall" || l == "/uninstall"
        }) || !Package::exists();
        let title = if uninstall { UNINSTALL_TITLE } else { APP_TITLE };

        let style = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
        let hwnd = windows::Win32::UI::WindowsAndMessaging::CreateWindowExW(
            WS_EX_LAYERED,
            w!("FleetSetupWindow"),
            PCWSTR(to_wide(title).as_ptr()),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            WIN_W,
            WIN_H,
            None,
            None,
            Some(hinst),
            None,
        )
        .unwrap_or(HWND(std::ptr::null_mut()));
        if hwnd.0.is_null() {
            return;
        }

        let _ = ShowWindow(hwnd, SW_SHOW);

        // Build the opening page on the now-visible window, then fade in.
        if let Some(a) = app_from(hwnd) {
            build_stage(a);
            if a.resolving {
                start_resolve(a);
            }
            start_fade(a, 255, 350, After::None);
        }

        // Message pump with dialog-style Tab/Enter/Esc handling.
        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 <= 0 {
                break;
            }
            if !IsDialogMessageW(hwnd, &msg).as_bool() {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}
