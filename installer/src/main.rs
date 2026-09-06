// Fleet's custom installer - a real Win32 app, not a wizard.
//
// Flow (install):   Hello! (fades away) -> choose a folder -> Confirm ->
//                   Install Fleet -> (fades away) -> installing -> done.
// Flow (uninstall): Remove Fleet? -> removing -> gone.
//
// Every control is a REAL native Windows control (BUTTON / EDIT / STATIC /
// msctls_progress32) with comctl32 v6 visual styles from the embedded
// manifest. Nothing is owner-drawn; no fake chrome anywhere.

#![cfg_attr(not(feature = "console"), windows_subsystem = "windows")]

mod payload;
mod shell;

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, CreateSolidBrush, DeleteObject, SetBkColor, SetBkMode, SetTextColor, TRANSPARENT,
    FONT_CHARSET, FONT_CLIP_PRECISION, FONT_OUTPUT_PRECISION, FONT_QUALITY,
    HBRUSH, HFONT, HGDIOBJ, HDC,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::Controls::{InitCommonControlsEx, INITCOMMONCONTROLSEX, PBM_SETMARQUEE};
use windows::Win32::UI::HiDpi::{GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRect, BN_CLICKED, BM_GETCHECK, BM_SETCHECK, CREATESTRUCTW, CW_USEDEFAULT,
    DefWindowProcW, DestroyWindow, DispatchMessageW, GetClassNameW, GetDlgCtrlID, GetMessageW,
    GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GWLP_USERDATA, HMENU, HWND_TOP,
    IDC_ARROW, IDI_APPLICATION, IDOK, IsDialogMessageW, IsWindowVisible, KillTimer,
    LoadCursorW, LoadIconW, MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassW,
    SendMessageW, SetLayeredWindowAttributes, SetTimer, SetWindowLongPtrW, SetWindowPos,
    SetWindowTextW, ShowWindow,
    SystemParametersInfoW, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    WS_CAPTION, WS_EX_CLIENTEDGE, WS_EX_LAYERED, WS_MINIMIZEBOX, WS_SYSMENU,
    LWA_ALPHA, MB_DEFBUTTON2, MB_ICONQUESTION, MB_OKCANCEL, MSG,
    SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER, SPI_GETWORKAREA,
    WM_CLOSE, WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC, WM_DPICHANGED, WM_NCDESTROY,
    WM_NCCREATE, WM_SETFONT, WM_TIMER,
};

use payload::Package;
use shell::{to_wide, CSIDL_DESKTOPDIRECTORY, CSIDL_PROGRAMS};

// ------------------------------------------------------------------ branding

const FLEET_VERSION: &str = env!("FLEET_VERSION");
const APP_TITLE: &str = "Fleet Setup";
const UNINSTALL_TITLE: &str = "Fleet Uninstaller";

const INK: u32 = 0x001B_1B1B; // near-black      (COLORREF is 0x00BBGGRR)
const INK_2: u32 = 0x006E_6E6E; // secondary
const RED: u32 = 0x001C_2BC4; // error red #C42B1C
const BG: u32 = 0x00FF_FFFF; // white

// Timer ids
const IDT_FADE: usize = 1;
const IDT_HELLO: usize = 2;
const IDT_DEMO: usize = 3;
const IDT_POLL: usize = 4;

// Static control ids (drive per-control colors)
const IDC_HEAD: i32 = 1;
const IDC_SUB: i32 = 2;
const IDC_PATH: i32 = 3;
const IDC_HINT: i32 = 4;
const IDC_ERROR: i32 = 5;
const IDC_BYTES: i32 = 6;
const IDC_FILE: i32 = 7;
const IDC_HELLO: i32 = 8;

// Interactive control ids
const IDC_PATHEDIT: i32 = 120;
const IDC_BROWSE: i32 = 101;
const IDC_CONFIRM: i32 = 102;
const IDC_INSTALL: i32 = 103;
const IDC_CHANGE: i32 = 104;
const IDC_LAUNCH: i32 = 105;
const IDC_CLOSE: i32 = 106;
const IDC_CHECK_DESKTOP: i32 = 107;
const IDC_REMOVE: i32 = 110;
const IDC_CHECK_DATA: i32 = 112;
const IDC_RETRY: i32 = 113;
// Esc / cancel command id (Win32 IDCANCEL == 2).
const IDC_CANCEL: i32 = 2;

// Window metrics (logical pixels at 96 DPI)
const WIN_W: i32 = 500;
const WIN_H: i32 = 360;

// ------------------------------------------------------------------ state

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Hello,
    Location,
    Ready,
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
    hello: HFONT,
    head: HFONT,
    body: HFONT,
    path: HFONT,
    small: HFONT,
}

enum After {
    None,
    Show(Stage),
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

fn make_font(weight: i32, logical_height: i32, scale: f32) -> HFONT {
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
            w!("Segoe UI"),
        )
    }
}

// ------------------------------------------------------------------ install workers

fn run_install(dest: &PathBuf, desktop: bool, version: &str, tx: &Sender<Msg>) -> Result<(), String> {
    debug_log("run_install start");
    let pkg = Package::open()
        .ok_or("This copy of the installer is missing its files.\nPlease download Fleet again.")?;
    let entries = pkg.entries()?;
    let total: u64 = entries.iter().map(|e| e.raw_size).sum();

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

    // Optional WebView2 runtime (bundled bootstrapper, silent).
    let bootstrapper = std::env::temp_dir().join("Fleet_WebView2Setup.exe");
    if !shell::webview2_installed() && bootstrapper.exists() {
        let _ = tx.send(Msg::Note("Setting up the WebView2 runtime - one time only…".into()));
        shell::install_webview2(&bootstrapper)?;
    }

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
            // Uninstall mode always operates on the folder we live in
            // (the registry UninstallString points here).
            let path = if uninstall {
                exe_dir
            } else {
                preset_path.unwrap_or(default_path)
            };

            let fonts = Fonts {
                hello: make_font(600, 40, scale),
                head: make_font(600, 22, scale),
                body: make_font(400, 13, scale),
                path: make_font(400, 14, scale),
                small: make_font(400, 12, scale),
            };
            let app = Box::new(App {
                hwnd,
                hinst,
                brush: CreateSolidBrush(COLORREF(BG)),
                fonts,
                scale,
                uninstall_mode: uninstall,
                demo,
                stage: if uninstall { Stage::UninstallConfirm } else { Stage::Hello },
                ctrls: Vec::new(),
                alpha: 0,
                path,
                desktop_shortcut: true,
                delete_data: false,
                last_error: String::new(),
                install_dest: PathBuf::new(),
                rx: None,
                busy: false,
                fade: Fade { active: false, from: 0, to: 255, t0: 0, dur: 1, after: After::None },
            });
            let raw = Box::into_raw(app);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, raw as isize);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_CREATE => {
            if let Some(a) = app_from(hwnd) {
                size_window(a);
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
                    IDT_HELLO => {
                        let _ = KillTimer(Some(hwnd), IDT_HELLO);
                        goto_stage(a, Stage::Location);
                    }
                    IDT_DEMO => {
                        let _ = KillTimer(Some(hwnd), IDT_DEMO);
                        demo_advance(a);
                    }
                    IDT_POLL => poll_worker(a),
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
                let color = match GetDlgCtrlID(ctl) {
                    IDC_HEAD | IDC_HELLO => INK,
                    IDC_SUB | IDC_PATH | IDC_HINT | IDC_BYTES | IDC_FILE => INK_2,
                    IDC_ERROR => RED,
                    _ => INK_2,
                };
                SetTextColor(hdc, COLORREF(color));
                SetBkColor(hdc, COLORREF(BG));
                SetBkMode(hdc, TRANSPARENT);
                return LRESULT(a.brush.0 as isize);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_CLOSE => {
            if let Some(a) = app_from(hwnd) {
                if a.busy {
                    let text = if a.uninstall_mode {
                        "Fleet isn't finished removing itself yet.\nQuit anyway?"
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
                build_stage(a);
            }
            LRESULT(0)
        }

        WM_NCDESTROY => {
            let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if raw != 0 {
                drop(Box::from_raw(raw as *mut App));
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
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
        let _ = DeleteObject(HGDIOBJ(a.fonts.hello.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.head.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.body.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.path.0));
        let _ = DeleteObject(HGDIOBJ(a.fonts.small.0));
    }
    a.fonts = Fonts {
        hello: make_font(600, 40, s),
        head: make_font(600, 22, s),
        body: make_font(400, 13, s),
        path: make_font(400, 14, s),
        small: make_font(400, 12, s),
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
        match after {
            After::None => {
                if a.stage == Stage::Hello {
                    // Hold "Hello!" for a beat before it fades away.
                    let _ = SetTimer(Some(a.hwnd), IDT_HELLO, 1150, None);
                }
            }
            After::Show(next) => {
                a.stage = next;
                build_stage(a);
                start_fade(a, 255, 260, After::None);
            }
            After::Quit => {
                let _ = DestroyWindow(a.hwnd);
            }
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

fn goto_stage(a: &mut App, next: Stage) {
    start_fade(a, 0, 240, After::Show(next));
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
            ($a:expr, $text:expr, $extra:expr, $x:expr, $y:expr, $w:expr, $h:expr, $id:expr, $font:expr) => {
                add_ctrl(
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
                )
            };
        }
        macro_rules! checkbox {
            ($a:expr, $text:expr, $x:expr, $y:expr, $w:expr, $h:expr, $id:expr, $font:expr) => {
                button!($a, $text, 0x3, $x, $y, $w, $h, $id, $font)
            };
        }
        macro_rules! divider {
            ($a:expr) => {
                add_ctrl(
                    $a,
                    CtrlSpec {
                        class: w!("STATIC"),
                        text: "",
                        style: VISIBLE | 0x10, // SS_ETCHEDHORZ
                        ex: 0,
                        x: 36,
                        y: 282,
                        w: 428,
                        h: 2,
                        id: 0,
                        font: None,
                    },
                )
            };
        }

        match a.stage {
            Stage::Hello => {
                // NOTE: SS_CENTER | SS_CENTERIMAGE equals SS_ICON (0x3), which
                // renders nothing for text - so the rect is hand-centered.
                static_text!(a, "Hello!", 0x1, Some(f.hello), 0, 148, WIN_W, 64, IDC_HELLO);
            }

            Stage::Location => {
                let path_text = a.path.clone();
                static_text!(a, "Where should Fleet live?", 0, Some(f.head), 36, 44, 428, 32, IDC_HEAD);
                static_text!(
                    a,
                    "Fleet keeps everything in one folder. You can move it later if you change your mind.",
                    0x2000, // SS_EDITCONTROL (wraps)
                    Some(f.body),
                    36, 84, 410, 42, IDC_SUB
                );

                let edit = add_ctrl(
                    a,
                    CtrlSpec {
                        class: w!("EDIT"),
                        text: &path_text,
                        style: VISIBLE | TABSTOP | 0x80, // ES_AUTOHSCROLL
                        ex: WS_EX_CLIENTEDGE.0,
                        x: 36,
                        y: 148,
                        w: 294,
                        h: 32,
                        id: IDC_PATHEDIT,
                        font: Some(f.path),
                    },
                );
                let _ = SendMessageW(edit, 0x00D5, Some(WPARAM(1024)), Some(LPARAM(0))); // EM_LIMITTEXT

                button!(a, "Browse…", 0, 344, 148, 120, 32, IDC_BROWSE, f.body);

                let err = static_text!(a, "", 0, Some(f.small), 36, 190, 428, 20, IDC_ERROR);
                let _ = ShowWindow(err, SW_HIDE);

                divider!(a);
                static_text!(
                    a,
                    "Installs for you - no admin needed.",
                    0,
                    Some(f.small),
                    36, 296, 230, 36, IDC_HINT
                );

                button!(a, "Confirm", 0x1, 344, 298, 120, 32, IDC_CONFIRM, f.body);
                focus_ctrl(a, IDC_PATHEDIT);
            }

            Stage::Ready => {
                let path_text = a.path.clone();
                static_text!(a, "Ready to install.", 0, Some(f.head), 36, 44, 428, 32, IDC_HEAD);
                static_text!(a, "Fleet will live here:", 0, Some(f.body), 36, 84, 428, 20, IDC_SUB);
                static_text!(a, &path_text, 0x4000, Some(f.path), 36, 110, 428, 26, IDC_PATH);

                button!(a, "Change folder", 0, 36, 148, 130, 30, IDC_CHANGE, f.body);

                let ck = checkbox!(a, "Create a desktop shortcut", 36, 208, 300, 28, IDC_CHECK_DESKTOP, f.body);
                let st = if a.desktop_shortcut { windows::Win32::UI::Controls::BST_CHECKED.0 as usize } else { 0 };
                let _ = SendMessageW(ck, BM_SETCHECK, Some(WPARAM(st as usize)), Some(LPARAM(0)));

                divider!(a);
                button!(a, "Install Fleet", 0x1, 344, 298, 120, 32, IDC_INSTALL, f.body);
                focus_ctrl(a, IDC_INSTALL);
            }

            Stage::Installing => {
                static_text!(a, "Installing Fleet…", 0, Some(f.head), 36, 44, 428, 32, IDC_HEAD);
                static_text!(a, "Copying files…", 0, Some(f.body), 36, 84, 428, 20, IDC_SUB);

                let prog = add_ctrl(
                    a,
                    CtrlSpec {
                        class: w!("msctls_progress32"),
                        text: "",
                        style: VISIBLE,
                        ex: 0,
                        x: 36,
                        y: 124,
                        w: 428,
                        h: 12,
                        id: 0,
                        font: None,
                    },
                );
                let _ = SendMessageW(prog, 0x0406, Some(WPARAM(0)), Some(LPARAM(10000))); // PBM_SETRANGE32

                static_text!(a, "", 0, Some(f.small), 36, 148, 428, 20, IDC_BYTES);
                static_text!(a, "", 0x4000, Some(f.small), 36, 172, 428, 20, IDC_FILE);
            }

            Stage::Done => {
                let dest_text = a.install_dest.to_string_lossy().to_string();
                static_text!(a, "Fleet is installed.", 0, Some(f.head), 36, 72, 428, 32, IDC_HEAD);
                static_text!(a, "Launch it whenever you're ready.", 0, Some(f.body), 36, 112, 428, 20, IDC_SUB);
                static_text!(
                    a,
                    &dest_text,
                    0x4000,
                    Some(f.small),
                    36, 140, 428, 24, IDC_PATH
                );

                divider!(a);
                button!(a, "Close", 0, 224, 298, 100, 32, IDC_CLOSE, f.body);
                button!(a, "Launch Fleet", 0x1, 344, 298, 120, 32, IDC_LAUNCH, f.body);
                focus_ctrl(a, IDC_LAUNCH);
            }

            Stage::Error => {
                let err_text = a.last_error.clone();
                static_text!(a, "That didn't work.", 0, Some(f.head), 36, 44, 428, 32, IDC_HEAD);
                static_text!(a, &err_text, 0x2000, Some(f.body), 36, 84, 420, 110, IDC_SUB);

                divider!(a);
                button!(a, "Close", 0, 224, 298, 100, 32, IDC_CLOSE, f.body);
                button!(a, "Try again", 0x1, 344, 298, 120, 32, IDC_RETRY, f.body);
                focus_ctrl(a, IDC_RETRY);
            }

            Stage::UninstallConfirm => {
                static_text!(a, "Remove Fleet?", 0, Some(f.head), 36, 96, 428, 32, IDC_HEAD);
                static_text!(
                    a,
                    "This removes Fleet's program files from your PC. Your saved accounts and settings stay where they are.",
                    0x2000,
                    Some(f.body),
                    36, 136, 420, 44, IDC_SUB
                );

                let ck = checkbox!(a, "Also delete accounts and settings", 36, 210, 340, 28, IDC_CHECK_DATA, f.body);
                let st = if a.delete_data { windows::Win32::UI::Controls::BST_CHECKED.0 as usize } else { 0 };
                let _ = SendMessageW(ck, BM_SETCHECK, Some(WPARAM(st as usize)), Some(LPARAM(0)));

                divider!(a);
                button!(a, "Cancel", 0, 224, 298, 100, 32, IDC_CANCEL, f.body);
                button!(a, "Remove", 0x1, 344, 298, 120, 32, IDC_REMOVE, f.body);
                focus_ctrl(a, IDC_REMOVE);
            }

            Stage::Uninstalling => {
                static_text!(a, "Removing Fleet…", 0, Some(f.head), 36, 44, 428, 32, IDC_HEAD);
                static_text!(a, "Removing files…", 0, Some(f.body), 36, 84, 428, 20, IDC_SUB);

                let prog = add_ctrl(
                    a,
                    CtrlSpec {
                        class: w!("msctls_progress32"),
                        text: "",
                        style: VISIBLE | 0x08, // PBS_MARQUEE
                        ex: 0,
                        x: 36,
                        y: 124,
                        w: 428,
                        h: 12,
                        id: 0,
                        font: None,
                    },
                );
                let _ = SendMessageW(prog, PBM_SETMARQUEE, Some(WPARAM(1)), Some(LPARAM(30)));
            }

            Stage::Uninstalled => {
                static_text!(a, "Fleet is gone.", 0, Some(f.head), 36, 124, 428, 32, IDC_HEAD);
                static_text!(
                    a,
                    "All of Fleet's program files were removed.",
                    0x2000,
                    Some(f.body),
                    36, 164, 420, 44, IDC_SUB
                );

                divider!(a);
                button!(a, "Close", 0x1, 344, 298, 120, 32, IDC_CLOSE, f.body);
                focus_ctrl(a, IDC_CLOSE);
            }
        }

        if a.demo {
            let delay: usize = match a.stage {
                Stage::Location => 2200,
                Stage::Ready => 2000,
                Stage::Done => 3000,
                Stage::UninstallConfirm => 2000,
                _ => 0,
            };
            if delay > 0 {
                let _ = SetTimer(Some(a.hwnd), IDT_DEMO, delay as u32, None);
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
        IDC_CONFIRM => match validate_path(&a.path) {
            Ok(clean) => {
                a.path = clean;
                goto_stage(a, Stage::Ready);
            }
            Err(msg) => unsafe {
                if let Some(err) = a.ctrls.iter().find(|c| GetDlgCtrlID(**c) == IDC_ERROR) {
                    let _ = SetWindowTextW(*err, PCWSTR(to_wide(msg).as_ptr()));
                    let _ = ShowWindow(*err, SW_SHOW);
                }
            },
        },
        IDC_CHANGE => goto_stage(a, Stage::Location),
        IDC_INSTALL | IDC_RETRY => {
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
        Stage::Location => on_button(a, IDC_CONFIRM),
        Stage::Ready => on_button(a, IDC_INSTALL),
        Stage::Done | Stage::Uninstalled => fade_quit(a),
        Stage::UninstallConfirm => on_button(a, IDC_REMOVE),
        _ => {}
    }
}

// ------------------------------------------------------------------ worker plumbing

fn start_install(a: &mut App) {
    let dest = a.install_dest.clone();
    let desktop = a.desktop_shortcut;
    let version = FLEET_VERSION.to_string();
    let (tx, rx) = channel::<Msg>();
    a.rx = Some(rx);
    a.busy = true;
    unsafe {
        let _ = SetTimer(Some(a.hwnd), IDT_POLL, 40, None);
    }
    std::thread::spawn(move || match run_install(&dest, desktop, &version, &tx) {
        Ok(()) => {
            let _ = tx.send(Msg::Done);
        }
        Err(e) => {
            debug_log(&format!("install error: {e}"));
            let _ = tx.send(Msg::Err(e));
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
            let _ = SendMessageW(*ctl, 0x0405, Some(WPARAM(pos)), Some(LPARAM(0))); // PBM_SETPOS
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

        // Build the opening stage on the now-visible window, then fade in.
        if let Some(a) = app_from(hwnd) {
            build_stage(a);
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
