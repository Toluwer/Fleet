// Fleet installer - a borderless window rendered entirely by Fleet.
//
// The whole surface - shape, corners, text, buttons, progress - is drawn by
// GDI+ into a 32-bit premultiplied-alpha bitmap and pushed with
// UpdateLayeredWindow. The corners are rounded by our own anti-aliased mask,
// so they look the same on every Windows version (10 included). No native
// caption, no wizard controls, no message boxes: the only external windows
// are the OS folder picker and the WebView2 bootstrapper.
//
// Flow (fresh):     folder + shortcut -> Install Fleet -> progress -> done.
// Flow (update):    v{old} -> v{new} -> Update Fleet -> progress -> done.
// Flow (same ver):  up to date -> Close.
// Flow (uninstall): Remove Fleet? -> progress -> removed.

#![cfg_attr(not(feature = "console"), windows_subsystem = "windows")]

mod payload;
mod shell;
mod net;

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    COLORREF, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, BLENDFUNCTION, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, DIB_RGB_COLORS, GetDC,
    LOGFONTW, ReleaseDC, ScreenToClient, SelectObject, HBITMAP, HGDIOBJ, HDC,
};
use windows::Win32::Graphics::GdiPlus::{
    CombineModeReplace, FillModeAlternate, FlushIntentionFlush, GdipAddPathArc, GdipClosePathFigures,
    GdipCreateBitmapFromScan0, GdipCreateFontFromLogfontW, GdipCreatePath, GdipCreatePen1,
    GdipCreateSolidFill, GdipCreateStringFormat, GdipDeleteBrush, GdipDeleteFont,
    GdipDeleteGraphics, GdipDeletePath, GdipDeletePen, GdipDeleteStringFormat, GdipDisposeImage,
    GdipDrawLine, GdipDrawPath, GdipDrawString, GdipFillPath, GdipFillRectangleI, GdipFlush,
    GdipGetImageGraphicsContext, GdipGraphicsClear, GdipResetClip, GdipSetClipPath,
    GdipSetSmoothingMode, GdipSetStringFormatAlign, GdipSetStringFormatFlags,
    GdipSetStringFormatLineAlign, GdipSetStringFormatTrimming, GdipSetTextRenderingHint,
    GdiplusStartup, GdiplusStartupInput, RectF, SmoothingModeAntiAlias, Status,
    StringAlignmentCenter, StringAlignmentFar, StringAlignmentNear, StringFormatFlagsNoWrap,
    StringTrimmingEllipsisCharacter, TextRenderingHintAntiAliasGridFit, UnitPixel, GpBitmap, GpBrush,
    GpFont, GpGraphics, GpImage, GpPath, GpPen, GpSolidFill, GpStringFormat,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_CONTROL, VK_ESCAPE, VK_RETURN, VK_SPACE, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CreateWindowExW, CW_USEDEFAULT, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetCursorPos, GetMessageW, GetWindowLongPtrW, GetWindowRect, GWLP_USERDATA, HWND_TOP, HTCAPTION,
    HTCLIENT, IDC_ARROW, IDI_APPLICATION, KillTimer, LoadCursorW, LoadIconW, MSG, PostMessageW,
    PostQuitMessage, RegisterClassW, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    SystemParametersInfoW, TranslateMessage, ULW_ALPHA, UpdateLayeredWindow, WINDOW_EX_STYLE,
    WINDOW_STYLE, WNDCLASSW, WM_CHAR, WM_CLOSE, WM_DPICHANGED, WM_ERASEBKGND, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCDESTROY,
    WM_NCCREATE, WM_TIMER, WS_EX_LAYERED, WS_POPUP, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER,
    SPI_GETWORKAREA,
};

use payload::Package;
use shell::{to_wide, CSIDL_DESKTOPDIRECTORY, CSIDL_PROGRAMS};

// ------------------------------------------------------------------ branding

const FLEET_VERSION: &str = env!("FLEET_VERSION");
const APP_TITLE: &str = "Fleet Setup";
const UNINSTALL_TITLE: &str = "Fleet Uninstaller";

// Fleet's palette (COLORREF is 0x00BBGGRR).
const BG: u32     = 0x0013_0F0E; // #0e0f13 window
const INK: u32    = 0x00F1_F0F4; // #f4f0f1 primary text
const INK_2: u32  = 0x00A7_A3AA; // #aaa3a7 secondary text
const INK_3: u32  = 0x0071_6C72; // #726c71 muted text
const HAIR: u32   = 0x002E_2626; // #26262e hairlines
const TRACK: u32  = 0x0034_2D2C; // #2c2d34 progress track
const ACCENT: u32 = 0x00F6_823B; // #3b82f6 Fleet blue
const DANGER: u32 = 0x00AC_9BFF; // #ff9bac error text

// Buttons (match the app's .btn styles).
const SURFACE: u32   = 0x0020_1A1A;
const SURFACE_2: u32 = 0x0027_2020;
const SURFACE_3: u32 = 0x0030_2727;
const HAIR_2: u32   = 0x0047_3D3D;
const ON_INK: u32    = 0x00FF_FBF8;
const PRIM: u32      = 0x00EB_6325;
const PRIM_DOWN: u32 = 0x00CE_5720;
const PRIM_OFF: u32  = 0x0069_31_17;
const PRIM_OFF_TX: u32 = 0x00A5_81_71;
const SEC_OFF: u32   = 0x0018_1313;
const DANGER_RING: u32 = 0x0035_266E;
const DANGER_EDGE: u32 = 0x0059_42DC;
const DANGER_HOT: u32  = 0x001D_1632;
const DANGER_DOWN: u32 = 0x0019_132A;
const FOCUS_TX: u32   = 0x00FF_CBA9;

// Caption close button (matches the app's window controls).
const CLOSE_HOT: u32 = 0x001C_2BC4;   // #c42b1c
const CLOSE_DOWN: u32 = 0x001D_27A4;  // #a4271d

/// Corner radius in logical pixels (the app's own window radius).
const WIN_RADIUS: f32 = 8.0;
const BTN_RADIUS: f32 = 8.0;

// Timers
const IDT_FADE: usize = 1;
const IDT_DEMO: usize = 3;
const IDT_POLL: usize = 4;
const IDT_RESOLVE: usize = 5;
const IDT_SWEEP: usize = 6;
const IDT_CARET: usize = 7;
const IDT_HOVER: usize = 8;

// Widget ids.
const IDC_HEAD: i32 = 1;
const IDC_SUB: i32 = 2;
const IDC_PATH: i32 = 3;
const IDC_HINT: i32 = 4;
const IDC_ERROR: i32 = 5;
const IDC_BYTES: i32 = 6;
const IDC_FILE: i32 = 7;
const IDC_TAG: i32 = 8;
const IDC_VERSION: i32 = 9;
const IDC_LABEL: i32 = 10;
const IDC_RULE: i32 = 11;

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
const IDC_CANCEL: i32 = 2;
const IDC_CAPCLOSE: i32 = 901; // caption close button

// Window metrics (logical pixels at 96 DPI).
const WIN_W: i32 = 520;
const WIN_H: i32 = 376;
const CLOSE_W: i32 = 46;
const CLOSE_H: i32 = 32;

// 32bpp premultiplied ARGB (GDI+ PixelFormat32bppPARGB).
const PF_PARGB: i32 = 0x000E_200B;

// ------------------------------------------------------------------ state

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Resolve,
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

struct Fonts {
    display: *mut GpFont,
    head: *mut GpFont,
    body: *mut GpFont,
    path: *mut GpFont,
    small: *mut GpFont,
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

/// The layered-window canvas: a 32-bit DIB wrapped by GDI+, presented with
/// UpdateLayeredWindow. The alpha channel is the window's shape.
struct Canvas {
    w: i32,
    h: i32,
    dc: HDC,
    bmp: HBITMAP,
    old: HGDIOBJ,
    gfx: *mut GpGraphics,
    image: *mut GpBitmap,
}

#[derive(Clone, Copy)]
enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy)]
enum FontRole {
    Head,
    Body,
    Path,
    Small,
}

/// One drawn element. Widgets are plain data: rendering, hit-testing and
/// keyboard focus all walk this list.
struct Wg {
    id: i32,
    kind: WgKind,
    /// Logical-pixel rect (scaled at draw time).
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

enum WgKind {
    Button {
        label: String,
        primary: bool,
        danger: bool,
        enabled: bool,
    },
    Check {
        label: String,
        checked: bool,
    },
    PathField,
    Text {
        text: String,
        ink: u32,
        align: Align,
        font: FontRole,
        wrap: bool,
        /// Top-align instead of vertically centering (multi-line blocks).
        top: bool,
    },
    Rule,
    Progress,
    CloseBtn,
}

struct App {
    hwnd: HWND,
    hinst: HINSTANCE,
    canvas: Option<Canvas>,
    fonts: Fonts,
    scale: f32,
    uninstall_mode: bool,
    demo: bool,
    stage: Stage,
    widgets: Vec<Wg>,
    /// Widget under the mouse.
    hot: Option<i32>,
    /// Widget with the button held down.
    pressed: Option<i32>,
    /// Widget with keyboard focus.
    focus: Option<i32>,
    caret_on: bool,
    alpha: u8,
    progress: f32,
    sweep: i32,
    path: String,
    desktop_shortcut: bool,
    delete_data: bool,
    last_error: String,
    install_dest: PathBuf,
    rx: Option<Receiver<Msg>>,
    busy: bool,
    fade: Fade,
    installed: Option<(PathBuf, String)>,
    updating: bool,
    latest: Option<net::Latest>,
    feed: Arc<Mutex<Option<Option<net::Latest>>>>,
    resolve_deadline: u64,
    resolving: bool,
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
        return Err("Enter a folder path, such as C:\\Apps\\Fleet.");
    }
    let unc = t.starts_with("\\\\");
    if !unc {
        let b = t.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return Err("Enter a full path starting with a drive letter, such as C:\\Apps\\Fleet.");
        }
        if b.len() == 3 {
            return Err("Choose a folder, not an entire drive.");
        }
    }
    let body = if unc { &t[2..] } else { &t[3..] };
    if body.contains(':') {
        return Err("That character is not allowed in a folder path.");
    }
    for ch in ['<', '>', '|', '?', '*'] {
        if body.contains(ch) {
            return Err("That character is not allowed in a folder path.");
        }
    }
    let mut cleaned = t.to_string();
    while cleaned.len() > 3 && cleaned.ends_with('\\') {
        cleaned.pop();
    }
    Ok(cleaned)
}

/// COLORREF (0x00BBGGRR) -> GDI+ ARGB (0xAARRGGBB).
fn argb(c: u32) -> u32 {
    0xFF00_0000 | ((c & 0x0000_00FF) << 16) | (c & 0x0000_FF00) | ((c & 0x00FF_0000) >> 16)
}

/// GDI+ font from a logical-font spec. Creation goes through the GDI font
/// mapper, so missing faces (Segoe UI Variable on older Windows) substitute
/// cleanly instead of falling back to a default serif.
unsafe fn make_font(face: &str, weight: i32, logical_height: i32, scale: f32, screen: HDC) -> *mut GpFont {
    let mut lf = LOGFONTW::default();
    lf.lfHeight = -((logical_height as f32 * scale).round() as i32);
    lf.lfWeight = weight;
    lf.lfCharSet = windows::Win32::Graphics::Gdi::FONT_CHARSET(1); // DEFAULT_CHARSET
    lf.lfOutPrecision = windows::Win32::Graphics::Gdi::FONT_OUTPUT_PRECISION(0);
    lf.lfClipPrecision = windows::Win32::Graphics::Gdi::FONT_CLIP_PRECISION(0);
    lf.lfQuality = windows::Win32::Graphics::Gdi::FONT_QUALITY(5); // CLEARTYPE_QUALITY
    lf.lfPitchAndFamily = 0x22; // VARIABLE_PITCH | FF_SWISS
    let wide: Vec<u16> = face.encode_utf16().chain(std::iter::once(0)).collect();
    let n = wide.len().min(31);
    lf.lfFaceName[..n].copy_from_slice(&wide[..n]);
    let mut font: *mut GpFont = std::ptr::null_mut();
    GdipCreateFontFromLogfontW(screen, &lf, &mut font);
    font
}

unsafe fn delete_fonts(f: &Fonts) {
    GdipDeleteFont(f.display);
    GdipDeleteFont(f.head);
    GdipDeleteFont(f.body);
    GdipDeleteFont(f.path);
    GdipDeleteFont(f.small);
}

unsafe fn build_fonts(scale: f32) -> Fonts {
    let screen = GetDC(None);
    let fonts = Fonts {
        display: make_font("Segoe UI Variable Display", 600, 24, scale, screen),
        head: make_font("Segoe UI Variable Display", 600, 17, scale, screen),
        body: make_font("Segoe UI Variable Text", 400, 13, scale, screen),
        path: make_font("Segoe UI Variable Text", 400, 14, scale, screen),
        small: make_font("Segoe UI Variable Text", 400, 12, scale, screen),
    };
    ReleaseDC(None, screen);
    fonts
}

// ------------------------------------------------------------------ canvas

unsafe fn canvas_create(w: i32, h: i32) -> Option<Canvas> {
    if w <= 0 || h <= 0 {
        return None;
    }
    let dc = CreateCompatibleDC(None);
    if dc.0.is_null() {
        return None;
    }
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: Default::default(),
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let bmp = CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
    if bits.is_null() {
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        return None;
    }
    let old = SelectObject(dc, HGDIOBJ(bmp.0));

    let mut image: *mut GpBitmap = std::ptr::null_mut();
    if GdipCreateBitmapFromScan0(w, h, w * 4, PF_PARGB, Some(bits as *const u8), &mut image) != Status(0)
        || image.is_null()
    {
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        return None;
    }
    let mut gfx: *mut GpGraphics = std::ptr::null_mut();
    if GdipGetImageGraphicsContext(image as *mut GpImage, &mut gfx) != Status(0) || gfx.is_null() {
        GdipDisposeImage(image as *mut GpImage);
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        return None;
    }
    GdipSetSmoothingMode(gfx, SmoothingModeAntiAlias);
    GdipSetTextRenderingHint(gfx, TextRenderingHintAntiAliasGridFit);
    Some(Canvas { w, h, dc, bmp, old, gfx, image })
}

unsafe fn canvas_destroy(c: Canvas) {
    GdipDeleteGraphics(c.gfx);
    GdipDisposeImage(c.image as *mut GpImage);
    let _ = SelectObject(c.dc, c.old);
    let _ = DeleteObject(HGDIOBJ(c.bmp.0));
    let _ = DeleteDC(c.dc);
}

/// Pushes the canvas to the screen. `alpha` scales the whole window (fades);
/// per-pixel alpha carries the rounded shape.
unsafe fn canvas_present(a: &App, alpha: u8) {
    let Some(c) = &a.canvas else { return };
    let size = SIZE { cx: c.w, cy: c.h };
    let src = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: alpha,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let _ = UpdateLayeredWindow(
        a.hwnd,
        None,
        None,
        Some(&size),
        Some(c.dc),
        Some(&src),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );
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
    // installed instead of it: an old installer still hands out the newest
    // Fleet. Same folder, same flow, same verification.
    let fetch_latest = latest
        .as_ref()
        .map(|l| version_cmp(&l.version, FLEET_VERSION) == std::cmp::Ordering::Greater)
        .unwrap_or(false);
    let pkg = if fetch_latest {
        let l = latest.as_ref().unwrap();
        let _ = tx.send(Msg::Note(format!("Downloading Fleet v{}…", l.version)));
        let url = net::asset_url(&l.zip_name);
        debug_log(&format!("fetching newer release {url}"));
        let tx_progress = tx.clone();
        let mut progress = move |done: u64, total: u64| {
            let _ = tx_progress.send(Msg::Bytes(done, total));
        };
        let bytes = net::http_get(&url, &mut progress)?;
        if !net::sha512_matches(&bytes, &l.sha512_b64) {
            return Err("The download failed verification.\nCheck the connection and try again.".into());
        }
        if l.size > 0 && bytes.len() as u64 != l.size {
            return Err("The download is incomplete.\nTry again.".into());
        }
        let _ = tx.send(Msg::Note("Extracting the new version…".into()));
        Package::from_bytes(bytes)
    } else {
        Package::open().ok_or("This installer is incomplete.\nDownload Fleet again.")?
    };
    let entries = pkg.entries()?;
    let total: u64 = entries.iter().map(|e| e.raw_size).sum();

    if is_update {
        // Replace the previous version in place: close the running app, clear
        // the old files, then extract the new payload over the same folder.
        let _ = tx.send(Msg::Note("Closing Fleet…".into()));
        shell::close_fleet_processes(dest);
        let _ = tx.send(Msg::Note("Removing the previous version…".into()));
        shell::wipe_dir(dest)?;
    }

    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Could not create {}:\n{e}", dest.display()))?;
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
        let _ = tx.send(Msg::Note("Installing the WebView2 runtime (one time only)…".into()));
        shell::install_webview2(&bootstrapper)?;
    }
    let _ = std::fs::remove_file(&bootstrapper);

    let _ = tx.send(Msg::Note("Finalizing…".into()));
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
                "Some files in {} could not be removed.\nClose Fleet and try again.\n\n{e}",
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
            let hinst = HINSTANCE(cs.hInstance.0);
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

            // An existing install decides the flow: older version -> update,
            // same or newer -> up to date, nothing -> fresh install.
            let installed = if uninstall { None } else { shell::installed_fleet() };

            // The release feed check runs on its own thread while the page
            // settles; an old installer learns the newest version this way and
            // installs it instead of its embedded payload. Uninstall never
            // needs the network.
            let feed: Arc<Mutex<Option<Option<net::Latest>>>> = Arc::new(Mutex::new(None));
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

            // Uninstall mode always operates on the folder we live in (the
            // registry UninstallString points here). Updates always go to the
            // folder the existing Fleet lives in.
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

            let fonts = build_fonts(scale);
            let mut app = Box::new(App {
                hwnd,
                hinst,
                canvas: None,
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
                widgets: Vec::new(),
                hot: None,
                pressed: None,
                focus: None,
                caret_on: true,
                alpha: 0,
                progress: 0.0,
                sweep: 0,
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
            });
            let raw = Box::into_raw(app);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, raw as isize);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_ERASEBKGND => LRESULT(1),

        WM_NCHITTEST => {
            // Drag anywhere that is not an interactive widget; there is no
            // caption to do it for us.
            if let Some(a) = app_from(hwnd) {
                let mut pt = POINT {
                    x: (lparam.0 & 0xFFFF) as u16 as i16 as i32,
                    y: ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32,
                };
                if ScreenToClient(hwnd, &mut pt).as_bool() {
                    let hit = widget_at(a, pt.x, pt.y);
                    if hit.is_some() {
                        return LRESULT(HTCLIENT as isize);
                    }
                    return LRESULT(HTCAPTION as isize);
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        // A borderless fixed-size window has no business maximizing.
        WM_NCLBUTTONDBLCLK => LRESULT(0),

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
                        if a.sweep > 120 {
                            a.sweep = 0;
                        }
                        render_present(a);
                    }
                    IDT_CARET => {
                        a.caret_on = !a.caret_on;
                        render_present(a);
                    }
                    IDT_HOVER => {
                        clear_stale_hover(a);
                    }
                    _ => {}
                }
            }
            LRESULT(0)
        }

        WM_MOUSEMOVE => {
            if let Some(a) = app_from(hwnd) {
                let x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
                let hit = widget_at(a, x, y);
                if hit != a.hot {
                    a.hot = hit;
                    if hit.is_some() {
                        let _ = SetTimer(Some(hwnd), IDT_HOVER, 80, None);
                    }
                    render_present(a);
                }
            }
            LRESULT(0)
        }

        WM_LBUTTONDOWN => {
            if let Some(a) = app_from(hwnd) {
                let x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
                if let Some(id) = widget_at(a, x, y) {
                    a.pressed = Some(id);
                    if is_focusable(a, id) {
                        a.focus = Some(id);
                    }
                    render_present(a);
                }
            }
            LRESULT(0)
        }

        WM_LBUTTONUP => {
            if let Some(a) = app_from(hwnd) {
                let x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
                let hit = widget_at(a, x, y);
                let pressed = a.pressed.take();
                if let (Some(p), Some(h)) = (pressed, hit) {
                    if p == h {
                        activate(a, p);
                    }
                }
                render_present(a);
            }
            LRESULT(0)
        }

        WM_KEYDOWN => {
            if let Some(a) = app_from(hwnd) {
                on_keydown(a, wparam.0 as u16);
            }
            LRESULT(0)
        }

        WM_CHAR => {
            if let Some(a) = app_from(hwnd) {
                on_char(a, wparam.0 as u32);
            }
            LRESULT(0)
        }

        WM_CLOSE => {
            if let Some(a) = app_from(hwnd) {
                // While files are moving there is no safe way out; the close
                // button dims and the request is ignored.
                if !a.busy {
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
                rebuild_canvas(a);
                build_stage(a);
                render_present(a);
            }
            LRESULT(0)
        }

        WM_NCDESTROY => {
            if let Some(a) = app_from(hwnd) {
                if let Some(c) = a.canvas.take() {
                    canvas_destroy(c);
                }
            }
            let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if raw != 0 {
                drop(Box::from_raw(raw as *mut App));
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            let r = DefWindowProcW(hwnd, msg, wparam, lparam);
            // The graceful exit path (fade_quit -> DestroyWindow) never posted
            // WM_QUIT, so the pump would block forever. This runs exactly once
            // per process.
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

fn size_window(a: &App) {
    unsafe {
        let w = (WIN_W as f32 * a.scale).round() as i32;
        let h = (WIN_H as f32 * a.scale).round() as i32;

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
    unsafe {
        delete_fonts(&a.fonts);
    }
    a.fonts = unsafe { build_fonts(a.scale) };
}

fn rebuild_canvas(a: &mut App) {
    unsafe {
        if let Some(c) = a.canvas.take() {
            canvas_destroy(c);
        }
        let w = (WIN_W as f32 * a.scale).round() as i32;
        let h = (WIN_H as f32 * a.scale).round() as i32;
        a.canvas = canvas_create(w, h);
    }
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
    canvas_present(a, alpha);
    if t >= 1.0 {
        let after = std::mem::replace(&mut a.fade.after, After::None);
        a.fade.active = false;
        let _ = KillTimer(Some(a.hwnd), IDT_FADE);
        if let After::Quit = after {
            let _ = DestroyWindow(a.hwnd);
        }
    }
}

fn fade_quit(a: &mut App) {
    start_fade(a, 0, 180, After::Quit);
}

/// One page: state changes rebuild the widget list in place.
fn goto_stage(a: &mut App, next: Stage) {
    a.stage = next;
    build_stage(a);
    render_present(a);
}

/// The first real page once the feed resolves.
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
    // "Updating" is decided against the version that will be installed.
    let effective = a.version_to_install();
    a.updating = a
        .installed
        .as_ref()
        .map(|(_, v)| version_cmp(v, &effective) == std::cmp::Ordering::Less)
        .unwrap_or(false);
    match a.stage {
        Stage::Resolve => goto_stage(a, first_stage(a)),
        Stage::Fresh => goto_stage(a, Stage::Fresh),
        _ => {}
    }
}

impl App {
    /// The version this run installs: the newest of the embedded payload and
    /// the GitHub release feed.
    fn version_to_install(&self) -> String {
        match &self.latest {
            Some(l) if version_cmp(&l.version, FLEET_VERSION) == std::cmp::Ordering::Greater => {
                l.version.clone()
            }
            _ => FLEET_VERSION.to_string(),
        }
    }
}

// ------------------------------------------------------------------ drawing

/// Builds a closed rounded-rectangle path (device pixels).
unsafe fn rounded_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> *mut GpPath {
    let mut path: *mut GpPath = std::ptr::null_mut();
    if GdipCreatePath(FillModeAlternate, &mut path) != Status(0) {
        return std::ptr::null_mut();
    }
    let d = 2.0 * r;
    GdipAddPathArc(path, x, y, d, d, 180.0, 90.0);
    GdipAddPathArc(path, x + w - d, y, d, d, 270.0, 90.0);
    GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0.0, 90.0);
    GdipAddPathArc(path, x, y + h - d, d, d, 90.0, 90.0);
    GdipClosePathFigures(path);
    path
}

unsafe fn fill_path(gfx: *mut GpGraphics, path: *mut GpPath, color: u32) {
    let mut brush: *mut GpSolidFill = std::ptr::null_mut();
    GdipCreateSolidFill(argb(color), &mut brush);
    GdipFillPath(gfx, brush as *mut GpBrush, path);
    GdipDeleteBrush(brush as *mut GpBrush);
}

unsafe fn stroke_path(gfx: *mut GpGraphics, path: *mut GpPath, color: u32, width: f32) {
    let mut pen: *mut GpPen = std::ptr::null_mut();
    GdipCreatePen1(argb(color), width, UnitPixel, &mut pen);
    GdipDrawPath(gfx, pen, path);
    GdipDeletePen(pen);
}

unsafe fn fill_rect(gfx: *mut GpGraphics, color: u32, x: i32, y: i32, w: i32, h: i32) {
    let mut brush: *mut GpSolidFill = std::ptr::null_mut();
    GdipCreateSolidFill(argb(color), &mut brush);
    GdipFillRectangleI(gfx, brush as *mut GpBrush, x, y, w, h);
    GdipDeleteBrush(brush as *mut GpBrush);
}

/// Single-line or wrapping text with GDI+ anti-aliasing.
unsafe fn draw_text(
    gfx: *mut GpGraphics,
    text: &str,
    font: *mut GpFont,
    color: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    align: Align,
    wrap: bool,
    top: bool,
) {
    let mut fmt: *mut GpStringFormat = std::ptr::null_mut();
    if GdipCreateStringFormat(0, 0, &mut fmt) != Status(0) || fmt.is_null() {
        return;
    }
    if !wrap {
        GdipSetStringFormatFlags(fmt, StringFormatFlagsNoWrap.0);
        GdipSetStringFormatTrimming(fmt, StringTrimmingEllipsisCharacter);
    }
    let halign = match align {
        Align::Left => StringAlignmentNear,
        Align::Center => StringAlignmentCenter,
        Align::Right => StringAlignmentFar,
    };
    let valign = if top { StringAlignmentNear } else { StringAlignmentCenter };
    GdipSetStringFormatAlign(fmt, halign);
    GdipSetStringFormatLineAlign(fmt, valign);

    let mut brush: *mut GpSolidFill = std::ptr::null_mut();
    GdipCreateSolidFill(argb(color), &mut brush);
    let rc = RectF { X: x, Y: y, Width: w, Height: h };
    let wide = to_wide(text);
    GdipDrawString(
        gfx,
        PCWSTR(wide.as_ptr()),
        -1,
        font,
        &rc,
        fmt,
        brush as *mut GpBrush,
    );
    GdipDeleteBrush(brush as *mut GpBrush);
    GdipDeleteStringFormat(fmt);
}

/// One push button: an anti-aliased 8px-rounded fill with centered label.
/// Mirrors the app's .btn, .btn.primary and .btn.danger styles.
unsafe fn draw_button(
    gfx: *mut GpGraphics,
    s: f32,
    fonts: &Fonts,
    wg: &Wg,
    label: &str,
    primary: bool,
    danger: bool,
    enabled: bool,
    hot: bool,
    pressed: bool,
    focused: bool,
) {
    let (fill, border, text) = if primary {
        if !enabled {
            (PRIM_OFF, None, PRIM_OFF_TX)
        } else if pressed {
            (PRIM_DOWN, None, ON_INK)
        } else if hot {
            (ACCENT, None, ON_INK)
        } else {
            (PRIM, None, ON_INK)
        }
    } else if danger {
        if pressed {
            (DANGER_DOWN, Some(DANGER_RING), DANGER)
        } else if hot {
            (DANGER_HOT, Some(DANGER_EDGE), DANGER)
        } else {
            (BG, Some(DANGER_RING), DANGER)
        }
    } else if !enabled {
        (SEC_OFF, Some(HAIR), INK_3)
    } else if pressed {
        (SURFACE_3, Some(HAIR_2), INK)
    } else if hot {
        (SURFACE_2, Some(HAIR_2), INK)
    } else {
        (SURFACE, Some(HAIR_2), INK)
    };

    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let r = (BTN_RADIUS * s).min(w / 2.0).min(h / 2.0).max(0.0);

    let path = rounded_path(x, y, w, h, r);
    if !path.is_null() {
        fill_path(gfx, path, fill);
        if let Some(b) = border {
            let bw = if s >= 2.0 { 2.0 } else { 1.0 };
            stroke_path(gfx, path, b, bw);
        }
        GdipDeletePath(path);
    }
    if focused && enabled {
        let inset = (2.0 * s).round().max(2.0).min(w.min(h) / 4.0);
        let fr = (r - inset).max(0.0);
        let fpath = rounded_path(x + inset, y + inset, w - 2.0 * inset, h - 2.0 * inset, fr);
        if !fpath.is_null() {
            let ring = if primary { FOCUS_TX } else { ACCENT };
            let rw = if s >= 2.0 { 2.0 } else { 1.0 };
            stroke_path(gfx, fpath, ring, rw);
            GdipDeletePath(fpath);
        }
    }
    draw_text(gfx, label, fonts.body, text, x, y, w, h, Align::Center, false, false);
}

/// A checkbox row: an 18px rounded box with a check glyph and a label.
unsafe fn draw_check(
    gfx: *mut GpGraphics,
    s: f32,
    fonts: &Fonts,
    wg: &Wg,
    label: &str,
    checked: bool,
    hot: bool,
    focused: bool,
) {
    let box_side = 18.0 * s;
    let bx = wg.x * s;
    let by = wg.y * s + (wg.h * s - box_side) / 2.0;
    let r = (4.0 * s).min(box_side / 2.0);

    let path = rounded_path(bx, by, box_side, box_side, r);
    if !path.is_null() {
        fill_path(gfx, path, if checked { PRIM } else { if hot { SURFACE_2 } else { SURFACE } });
        stroke_path(gfx, path, if checked { PRIM } else { HAIR_2 }, if s >= 2.0 { 2.0 } else { 1.0 });
        GdipDeletePath(path);
    }
    if checked {
        // Check glyph: two strokes, sized to the box.
        let cx = bx + box_side / 2.0;
        let cy = by + box_side / 2.0;
        let u = box_side * 0.24;
        let mut pen: *mut GpPen = std::ptr::null_mut();
        GdipCreatePen1(argb(ON_INK), (2.0 * s).max(1.4), UnitPixel, &mut pen);
        GdipDrawLine(gfx, pen, cx - u, cy, cx - u * 0.15, cy + u * 0.85);
        GdipDrawLine(gfx, pen, cx - u * 0.15, cy + u * 0.85, cx + u, cy - u * 0.85);
        GdipDeletePen(pen);
    }
    if focused {
        let fw = 2.0 * s;
        let ring = rounded_path(bx - fw, by - fw, box_side + 2.0 * fw, box_side + 2.0 * fw, r + fw);
        if !ring.is_null() {
            stroke_path(gfx, ring, ACCENT, if s >= 2.0 { 2.0 } else { 1.0 });
            GdipDeletePath(ring);
        }
    }
    draw_text(
        gfx,
        label,
        fonts.body,
        INK_2,
        bx + box_side + 10.0 * s,
        wg.y * s,
        wg.w * s - box_side - 10.0 * s,
        wg.h * s,
        Align::Left,
        false,
        false,
    );
}

/// The folder field: a dark input surface. Click focuses it for typing;
/// the caret marks the insertion point at the end of the path.
unsafe fn draw_path_field(
    gfx: *mut GpGraphics,
    s: f32,
    fonts: &Fonts,
    wg: &Wg,
    text: &str,
    focused: bool,
    caret_on: bool,
    hot: bool,
) {
    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let r = (BTN_RADIUS * s).min(h / 2.0);
    let path = rounded_path(x, y, w, h, r);
    if !path.is_null() {
        fill_path(gfx, path, if hot { SURFACE_2 } else { SURFACE });
        stroke_path(gfx, path, if focused { ACCENT } else { HAIR_2 }, if s >= 2.0 { 2.0 } else { 1.0 });
        GdipDeletePath(path);
    }
    let pad = 12.0 * s;
    draw_text(gfx, text, fonts.path, INK, x + pad, y, w - 2.0 * pad, h, Align::Left, false, false);
    if focused && caret_on {
        // Caret just past the text: measure nothing, clamp to the field.
        let char_w = 7.2 * s; // approx advance for Segoe UI 14pt
        let visible = ((w - 2.0 * pad) / char_w).floor().max(1.0) as usize;
        let shown_chars = text.chars().count().min(visible.saturating_sub(1).max(1));
        let cx = x + pad + shown_chars as f32 * char_w;
        let cx = cx.min(x + w - 8.0 * s);
        fill_rect(
            gfx,
            ACCENT,
            cx.round() as i32,
            (y + 7.0 * s).round() as i32,
            (1.6 * s).round().max(1.0) as i32,
            (h - 14.0 * s).round().max(4.0) as i32,
        );
    }
}

/// Flat progress bar: a rounded track with an accent fill.
unsafe fn draw_progress(gfx: *mut GpGraphics, s: f32, wg: &Wg, frac: f32, sweep: Option<i32>) {
    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let r = (h / 2.0).min(4.0 * s);
    let track = rounded_path(x, y, w, h, r);
    if track.is_null() {
        return;
    }
    fill_path(gfx, track, TRACK);
    GdipSetClipPath(gfx, track, CombineModeReplace);
    match sweep {
        Some(pos) => {
            // A short segment gliding across the track.
            let seg = (w * 0.28).max(12.0);
            let t = (pos as f32) / 120.0;
            let cx = x + t * (w + seg) - seg;
            fill_rect(gfx, ACCENT, cx.round() as i32, y.round() as i32, seg.round() as i32, h.round() as i32);
        }
        None => {
            let fw = (w * frac.clamp(0.0, 1.0)).round() as i32;
            if fw > 0 {
                fill_rect(gfx, ACCENT, x.round() as i32, y.round() as i32, fw, h.round() as i32);
            }
        }
    }
    GdipResetClip(gfx);
    GdipDeletePath(track);
}

/// The caption close button: 46x32 at native metrics, red hover like the app.
unsafe fn draw_close_btn(
    gfx: *mut GpGraphics,
    s: f32,
    wg: &Wg,
    window_path: *mut GpPath,
    hot: bool,
    pressed: bool,
    busy: bool,
) {
    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let glyph = if busy { INK_3 } else if hot { INK } else { INK_2 };
    if hot && !busy {
        // The fill is clipped to the window shape so the rounded corner
        // stays clean.
        GdipSetClipPath(gfx, window_path, CombineModeReplace);
        fill_rect(gfx, if pressed { CLOSE_DOWN } else { CLOSE_HOT }, x.round() as i32, y.round() as i32, w.round() as i32, h.round() as i32);
        GdipResetClip(gfx);
    }
    // 10px glyph: two crossing strokes.
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let u = 5.0 * s;
    let mut pen: *mut GpPen = std::ptr::null_mut();
    GdipCreatePen1(argb(glyph), (1.0 * s).max(1.0), UnitPixel, &mut pen);
    GdipDrawLine(gfx, pen, cx - u, cy - u, cx + u, cy + u);
    GdipDrawLine(gfx, pen, cx + u, cy - u, cx - u, cy + u);
    GdipDeletePen(pen);
}

/// Renders the whole window into the canvas and presents it at the current
/// fade alpha.
fn render_present(a: &App) {
    unsafe { render(a); }
    unsafe { canvas_present(a, a.alpha); }
}

unsafe fn render(a: &App) {
    let Some(c) = &a.canvas else { return };
    let gfx = c.gfx;
    let s = a.scale;
    let W = c.w as f32;
    let H = c.h as f32;

    GdipGraphicsClear(gfx, 0x0000_0000); // fully transparent

    // Window shape: 8px anti-aliased rounded rectangle.
    let radius = WIN_RADIUS * s;
    let window_path = rounded_path(0.0, 0.0, W, H, radius);
    if window_path.is_null() {
        return;
    }
    fill_path(gfx, window_path, BG);

    // Header: wordmark, tagline, version, close button, hairline.
    draw_text(gfx, "Fleet", a.fonts.display, INK, 36.0 * s, 26.0 * s, 300.0 * s, 34.0 * s, Align::Left, false, false);
    draw_text(gfx, "Multi-instance Roblox launcher", a.fonts.small, INK_3, 36.0 * s, 62.0 * s, 320.0 * s, 18.0 * s, Align::Left, false, false);
    let version_line = format!("v{}", a.version_to_install());
    draw_text(gfx, &version_line, a.fonts.small, INK_3, 324.0 * s, 34.0 * s, (WIN_W as f32 - 324.0 - CLOSE_W as f32 - 12.0) * s, 18.0 * s, Align::Right, false, false);

    for wg in &a.widgets {
        match &wg.kind {
            WgKind::CloseBtn => {
                draw_close_btn(
                    gfx, s, wg, window_path,
                    a.hot == Some(wg.id),
                    a.pressed == Some(wg.id),
                    a.busy,
                );
            }
            WgKind::Button { label, primary, danger, enabled } => {
                draw_button(
                    gfx, s, &a.fonts, wg, label, *primary, *danger, *enabled,
                    a.hot == Some(wg.id),
                    a.pressed == Some(wg.id),
                    a.focus == Some(wg.id),
                );
            }
            WgKind::Check { label, checked } => {
                draw_check(
                    gfx, s, &a.fonts, wg, label, *checked,
                    a.hot == Some(wg.id),
                    a.focus == Some(wg.id),
                );
            }
            WgKind::PathField => {
                draw_path_field(
                    gfx, s, &a.fonts, wg, &a.path,
                    a.focus == Some(IDC_PATHEDIT),
                    a.caret_on,
                    a.hot == Some(IDC_PATHEDIT),
                );
            }
            WgKind::Text { text, ink, align, font, wrap, top } => {
                let fobj = match font {
                    FontRole::Head => a.fonts.head,
                    FontRole::Body => a.fonts.body,
                    FontRole::Path => a.fonts.path,
                    FontRole::Small => a.fonts.small,
                };
                draw_text(gfx, text, fobj, *ink, wg.x * s, wg.y * s, wg.w * s, wg.h * s, *align, *wrap, *top);
            }
            WgKind::Rule => {
                fill_rect(gfx, HAIR, (wg.x * s).round() as i32, (wg.y * s).round() as i32, (wg.w * s).round() as i32, (wg.h * s).round() as i32);
            }
            WgKind::Progress => {
                let sweep = if matches!(a.stage, Stage::Uninstalling) { Some(a.sweep) } else { None };
                draw_progress(gfx, s, wg, a.progress, sweep);
            }
        }
    }

    GdipDeletePath(window_path);
    GdipFlush(gfx, FlushIntentionFlush);
}

// ------------------------------------------------------------------ stage UI

fn add_text(
    a: &mut App,
    id: i32,
    text: String,
    ink: u32,
    font: FontRole,
    align: Align,
    wrap: bool,
    top: bool,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) {
    a.widgets.push(Wg {
        id,
        kind: WgKind::Text { text, ink, align, font, wrap, top },
        x, y, w, h,
    });
}

fn add_button(a: &mut App, id: i32, label: &str, x: f32, y: f32, w: f32, h: f32, enabled: bool) {
    a.widgets.push(Wg {
        id,
        kind: WgKind::Button {
            label: label.to_string(),
            primary: is_primary(id),
            danger: id == IDC_REMOVE,
            enabled,
        },
        x, y, w, h,
    });
}

fn add_check(a: &mut App, id: i32, label: &str, checked: bool, x: f32, y: f32, w: f32, h: f32) {
    a.widgets.push(Wg {
        id,
        kind: WgKind::Check { label: label.to_string(), checked },
        x, y, w, h,
    });
}

fn add_rule(a: &mut App, y: f32) {
    a.widgets.push(Wg {
        id: IDC_RULE,
        kind: WgKind::Rule,
        x: 36.0,
        y,
        w: 448.0,
        h: 1.0,
    });
}

/// Footer band: hairline, optional hint, optional secondary button, primary.
fn add_footer(a: &mut App, hint: &str, secondary: Option<(&str, i32)>, primary_label: &str, primary_id: i32) {
    add_rule(a, 288.0);
    if let Some((label, id)) = secondary {
        add_button(a, id, label, 224.0, 304.0, 128.0, 32.0, true);
    }
    add_button(a, primary_id, primary_label, 368.0, 304.0, 116.0, 32.0, true);
    if !hint.is_empty() {
        add_text(a, IDC_HINT, hint.to_string(), INK_3, FontRole::Small, Align::Left, false, false, 36.0, 311.0, 320.0, 18.0);
    }
}

fn build_stage(a: &mut App) {
    a.widgets.clear();
    a.hot = None;
    a.pressed = None;
    a.progress = 0.0;
    unsafe {
        let _ = KillTimer(Some(a.hwnd), IDT_SWEEP);
        let _ = KillTimer(Some(a.hwnd), IDT_CARET);
    }

    // Caption close button (always present, dimmed while busy).
    a.widgets.push(Wg {
        id: IDC_CAPCLOSE,
        kind: WgKind::CloseBtn,
        x: (WIN_W - CLOSE_W) as f32,
        y: 0.0,
        w: CLOSE_W as f32,
        h: CLOSE_H as f32,
    });

    // Header hairline.
    add_rule(a, 96.0);

    match a.stage {
        Stage::Resolve => {
            add_text(a, IDC_SUB, "Checking for updates…".into(), INK_3, FontRole::Small, Align::Center, false, false, 36.0, 150.0, 448.0, 20.0);
        }

        Stage::Fresh => {
            add_text(a, IDC_LABEL, "Install folder".into(), INK_2, FontRole::Small, Align::Left, false, false, 36.0, 114.0, 448.0, 18.0);
            a.widgets.push(Wg {
                id: IDC_PATHEDIT,
                kind: WgKind::PathField,
                x: 36.0,
                y: 138.0,
                w: 316.0,
                h: 30.0,
            });
            add_button(a, IDC_BROWSE, "Browse…", 364.0, 138.0, 120.0, 30.0, true);
            add_text(a, IDC_ERROR, String::new(), DANGER, FontRole::Small, Align::Left, false, false, 36.0, 176.0, 448.0, 18.0);
            add_check(a, IDC_CHECK_DESKTOP, "Add a desktop shortcut", a.desktop_shortcut, 36.0, 212.0, 320.0, 24.0);

            // While the release feed is still resolving, Install waits so
            // nobody installs a stale payload seconds before the check hands
            // out the newest one.
            let hint = if a.resolving {
                "Checking for updates…"
            } else {
                "No administrator permissions required."
            };
            add_footer(a, hint, None, "Install Fleet", IDC_INSTALL);
            if a.resolving {
                if let Some(w) = a.widgets.iter_mut().find(|w| w.id == IDC_INSTALL) {
                    if let WgKind::Button { enabled, .. } = &mut w.kind {
                        *enabled = false;
                    }
                }
            }
            a.focus = Some(IDC_PATHEDIT);
            unsafe {
                let _ = SetTimer(Some(a.hwnd), IDT_CARET, 530, None);
            }
        }

        Stage::UpdateReady => {
            let old = a.installed.as_ref().map(|(_, v)| v.clone()).unwrap_or_default();
            let new_version = a.version_to_install();
            let sub = if old.is_empty() {
                format!("Fleet will be updated to v{new_version}.")
            } else {
                format!("Fleet v{old} will be updated to v{new_version}.")
            };
            let path_text = a.path.clone();
            add_text(a, IDC_HEAD, "Update available".into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 114.0, 448.0, 26.0);
            add_text(a, IDC_SUB, sub, INK_2, FontRole::Body, Align::Left, false, false, 36.0, 144.0, 448.0, 20.0);
            add_text(a, IDC_PATH, path_text, INK, FontRole::Path, Align::Left, false, false, 36.0, 168.0, 448.0, 20.0);
            add_text(
                a,
                IDC_HINT,
                "Fleet closes during the update. Accounts and settings are preserved.".into(),
                INK_3,
                FontRole::Small,
                Align::Left,
                true,
                true,
                36.0,
                198.0,
                448.0,
                36.0,
            );
            add_footer(a, "Same folder, updated in place.", None, "Update Fleet", IDC_INSTALL);
            a.focus = Some(IDC_INSTALL);
        }

        Stage::UpToDate => {
            let cur = a.installed.as_ref().map(|(_, v)| v.clone()).unwrap_or_default();
            let eff = a.version_to_install();
            let sub = if version_cmp(&cur, &eff) == std::cmp::Ordering::Equal {
                format!("The latest version, v{eff}, is installed.")
            } else {
                format!("A newer version, v{cur}, is installed.")
            };
            add_text(a, IDC_HEAD, "Fleet is up to date".into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 126.0, 448.0, 26.0);
            add_text(a, IDC_SUB, sub, INK_2, FontRole::Body, Align::Left, false, false, 36.0, 156.0, 448.0, 20.0);
            add_text(
                a,
                IDC_HINT,
                "Setup checks for the latest release, so an older download still installs the newest version.".into(),
                INK_3,
                FontRole::Small,
                Align::Left,
                true,
                true,
                36.0,
                184.0,
                448.0,
                36.0,
            );
            let secondary = if version_cmp(&cur, &eff) == std::cmp::Ordering::Greater {
                Some(("Get newer version", IDC_RELEASES))
            } else {
                None
            };
            add_footer(a, "", secondary, "Close", IDC_CLOSE);
            a.focus = Some(IDC_CLOSE);
        }

        Stage::Installing => {
            let (head, note) = if a.updating {
                ("Updating Fleet…", "Closing Fleet…")
            } else {
                ("Installing Fleet…", "Copying files…")
            };
            add_text(a, IDC_HEAD, head.into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 118.0, 448.0, 26.0);
            add_text(a, IDC_SUB, note.into(), INK_2, FontRole::Body, Align::Left, false, false, 36.0, 148.0, 448.0, 20.0);
            a.widgets.push(Wg {
                id: 0,
                kind: WgKind::Progress,
                x: 36.0,
                y: 178.0,
                w: 448.0,
                h: 8.0,
            });
            add_text(a, IDC_BYTES, String::new(), INK_3, FontRole::Small, Align::Left, false, false, 36.0, 198.0, 448.0, 16.0);
            add_text(a, IDC_FILE, String::new(), INK_3, FontRole::Small, Align::Left, false, false, 36.0, 218.0, 448.0, 16.0);
        }

        Stage::Done => {
            let dest_text = a.install_dest.to_string_lossy().to_string();
            let installed_version = a.version_to_install();
            let (head, sub) = if a.updating {
                ("Fleet is updated", format!("The latest version, v{installed_version}, is installed."))
            } else {
                ("Fleet is installed", "Ready to use.".to_string())
            };
            add_text(a, IDC_HEAD, head.into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 118.0, 448.0, 26.0);
            add_text(a, IDC_SUB, sub, INK_2, FontRole::Body, Align::Left, false, false, 36.0, 148.0, 448.0, 20.0);
            add_text(a, IDC_HINT, dest_text, INK_3, FontRole::Small, Align::Left, false, false, 36.0, 172.0, 448.0, 18.0);
            add_footer(a, "", Some(("Close", IDC_CLOSE)), "Launch Fleet", IDC_LAUNCH);
            a.focus = Some(IDC_LAUNCH);
        }

        Stage::Error => {
            let err_text = a.last_error.clone();
            let head = if a.uninstall_mode { "Removal failed" } else { "Setup failed" };
            add_text(a, IDC_HEAD, head.into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 114.0, 448.0, 26.0);
            add_text(a, IDC_SUB, err_text, INK_2, FontRole::Body, Align::Left, true, true, 36.0, 144.0, 448.0, 120.0);
            add_footer(a, "", Some(("Close", IDC_CLOSE)), "Try again", IDC_RETRY);
            a.focus = Some(IDC_RETRY);
        }

        Stage::UninstallConfirm => {
            add_text(a, IDC_HEAD, "Remove Fleet?".into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 118.0, 448.0, 26.0);
            add_text(
                a,
                IDC_SUB,
                "This removes Fleet's program files. Accounts and settings are kept.".into(),
                INK_2,
                FontRole::Body,
                Align::Left,
                true,
                true,
                36.0,
                148.0,
                448.0,
                40.0,
            );
            add_check(a, IDC_CHECK_DATA, "Also delete accounts and settings", a.delete_data, 36.0, 206.0, 340.0, 24.0);
            add_footer(a, "", Some(("Cancel", IDC_CANCEL)), "Remove", IDC_REMOVE);
            a.focus = Some(IDC_REMOVE);
        }

        Stage::Uninstalling => {
            add_text(a, IDC_HEAD, "Removing Fleet…".into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 118.0, 448.0, 26.0);
            add_text(a, IDC_SUB, "Removing files…".into(), INK_2, FontRole::Body, Align::Left, false, false, 36.0, 148.0, 448.0, 20.0);
            a.widgets.push(Wg {
                id: 0,
                kind: WgKind::Progress,
                x: 36.0,
                y: 178.0,
                w: 448.0,
                h: 8.0,
            });
            unsafe {
                let _ = SetTimer(Some(a.hwnd), IDT_SWEEP, 30, None);
            }
        }

        Stage::Uninstalled => {
            add_text(a, IDC_HEAD, "Fleet was removed".into(), INK, FontRole::Head, Align::Left, false, false, 36.0, 126.0, 448.0, 26.0);
            add_text(
                a,
                IDC_SUB,
                "All program files were removed.".into(),
                INK_2,
                FontRole::Body,
                Align::Left,
                true,
                true,
                36.0,
                156.0,
                448.0,
                40.0,
            );
            add_footer(a, "", None, "Close", IDC_CLOSE);
            a.focus = Some(IDC_CLOSE);
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
            unsafe {
                let _ = SetTimer(Some(a.hwnd), IDT_DEMO, delay, None);
            }
        }
    }
}

// ------------------------------------------------------------------ input

/// The widget under a client point, if it is interactive.
fn widget_at(a: &App, x: i32, y: i32) -> Option<i32> {
    let (x, y) = (x as f32, y as f32);
    let s = a.scale;
    for wg in &a.widgets {
        let interactive = match &wg.kind {
            WgKind::Button { enabled, .. } => *enabled,
            WgKind::Check { .. } => true,
            WgKind::PathField => true,
            WgKind::CloseBtn => true,
            _ => false,
        };
        if !interactive {
            continue;
        }
        if x >= wg.x * s && x < (wg.x + wg.w) * s && y >= wg.y * s && y < (wg.y + wg.h) * s {
            return Some(wg.id);
        }
    }
    None
}

fn is_focusable(a: &App, id: i32) -> bool {
    a.widgets.iter().any(|wg| {
        wg.id == id
            && match &wg.kind {
                WgKind::Button { enabled, .. } => *enabled,
                WgKind::Check { .. } | WgKind::PathField => true,
                _ => false,
            }
    })
}

/// Focusable widget ids in draw order (Tab order).
fn focus_ids(a: &App) -> Vec<i32> {
    a.widgets
        .iter()
        .filter(|wg| match &wg.kind {
            WgKind::Button { enabled, .. } => *enabled,
            WgKind::Check { .. } | WgKind::PathField => true,
            _ => false,
        })
        .map(|wg| wg.id)
        .collect()
}

fn cycle_focus(a: &mut App, backward: bool) {
    let ids = focus_ids(a);
    if ids.is_empty() {
        return;
    }
    let next = match a.focus {
        None => ids[0],
        Some(cur) => {
            let pos = ids.iter().position(|id| *id == cur).unwrap_or(0);
            let n = ids.len();
            if backward {
                ids[(pos + n - 1) % n]
            } else {
                ids[(pos + 1) % n]
            }
        }
    };
    a.focus = Some(next);
    render_present(a);
}

/// The stage's default action for Enter.
fn primary_id(a: &App) -> Option<i32> {
    let id = match a.stage {
        Stage::Fresh | Stage::UpdateReady => IDC_INSTALL,
        Stage::UpToDate | Stage::Uninstalled => IDC_CLOSE,
        Stage::Done => IDC_LAUNCH,
        Stage::Error => IDC_RETRY,
        Stage::UninstallConfirm => IDC_REMOVE,
        _ => return None,
    };
    if is_focusable(a, id) {
        Some(id)
    } else {
        None
    }
}

fn secondary_id(a: &App) -> Option<i32> {
    let id = match a.stage {
        Stage::UninstallConfirm => IDC_CANCEL,
        Stage::UpToDate => IDC_RELEASES,
        Stage::Done | Stage::Error => IDC_CLOSE,
        _ => return None,
    };
    if is_focusable(a, id) {
        Some(id)
    } else {
        None
    }
}

fn ctrl_key_down() -> bool {
    unsafe { (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 }
}

fn on_keydown(a: &mut App, vk: u16) {
    if vk == VK_TAB.0 {
        cycle_focus(a, ctrl_key_down());
    } else if vk == VK_RETURN.0 {
        // Enter runs the focused control; the path field defers to the
        // stage's primary action instead.
        let target = match a.focus {
            Some(IDC_PATHEDIT) => primary_id(a),
            Some(id) if is_focusable(a, id) => Some(id),
            _ => primary_id(a),
        };
        if let Some(id) = target {
            activate(a, id);
        }
    } else if vk == VK_SPACE.0 {
        if let Some(id) = a.focus {
            if id != IDC_PATHEDIT && is_focusable(a, id) {
                activate(a, id);
            }
        }
    } else if vk == VK_ESCAPE.0 {
        if let Some(id) = secondary_id(a) {
            activate(a, id);
        } else if !a.busy {
            unsafe {
                let _ = PostMessageW(Some(a.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    } else if vk == 0x56 {
        // Ctrl+V pastes into the path field.
        if a.focus == Some(IDC_PATHEDIT) && ctrl_key_down() {
            if let Some(text) = clipboard_text() {
                a.path.push_str(text.trim());
                a.path = a.path.trim().to_string();
                a.caret_on = true;
                set_text(a, IDC_ERROR, "");
                render_present(a);
            }
        }
    }
}

fn on_char(a: &mut App, ch: u32) {
    if a.focus != Some(IDC_PATHEDIT) {
        return;
    }
    match ch {
        0x08 => {
            // Backspace: drop the last character.
            let mut trimmed = a.path.clone();
            trimmed.pop();
            a.path = trimmed;
        }
        0x0D | 0x1B | 0x09 => return, // handled in on_keydown
        c if c >= 0x20 && c != 0x7F => {
            if let Some(chr) = char::from_u32(c) {
                if a.path.chars().count() < 260 {
                    a.path.push(chr);
                }
            }
        }
        _ => return,
    }
    a.caret_on = true;
    set_text(a, IDC_ERROR, "");
    render_present(a);
}

/// Clears hover/press state once the cursor leaves the window.
fn clear_stale_hover(a: &mut App) {
    unsafe {
        let mut cursor = POINT { x: 0, y: 0 };
        if !GetCursorPos(&mut cursor).is_ok() {
            return;
        }
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if !GetWindowRect(a.hwnd, &mut rect).is_ok() {
            return;
        }
        let outside = cursor.x < rect.left
            || cursor.x >= rect.right
            || cursor.y < rect.top
            || cursor.y >= rect.bottom;
        if outside && (a.hot.is_some() || a.pressed.is_some()) {
            a.hot = None;
            a.pressed = None;
            let _ = KillTimer(Some(a.hwnd), IDT_HOVER);
            render_present(a);
        }
    }
}

/// Reads CF_UNICODETEXT from the clipboard, if present.
fn clipboard_text() -> Option<String> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let mut result = None;
        if let Ok(handle) = GetClipboardData(13 /* CF_UNICODETEXT */) {
            let hglobal = HGLOBAL(handle.0);
            let ptr = GlobalLock(hglobal) as *const u16;
            if !ptr.is_null() {
                let mut len = 0usize;
                while *ptr.add(len) != 0 && len < 8192 {
                    len += 1;
                }
                result = Some(String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len)));
                let _ = GlobalUnlock(hglobal);
            }
        }
        let _ = CloseClipboard();
        result
    }
}

// ------------------------------------------------------------------ actions

fn is_primary(id: i32) -> bool {
    matches!(id, IDC_INSTALL | IDC_LAUNCH | IDC_RETRY)
}

fn activate(a: &mut App, id: i32) {
    debug_log(&format!("activate: id={id} stage={:?}", a.stage));
    match id {
        IDC_CAPCLOSE => unsafe {
            if !a.busy {
                let _ = PostMessageW(Some(a.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        },
        IDC_BROWSE => {
            let start = PathBuf::from(a.path.clone());
            let picked = unsafe { shell::pick_folder(a.hwnd, "Select a folder for Fleet", &start) };
            if let Some(dir) = picked {
                a.path = dir.to_string_lossy().to_string();
                set_text(a, IDC_ERROR, "");
                render_present(a);
            }
        }
        IDC_INSTALL | IDC_RETRY => {
            // The one-page form validates inline.
            if a.stage == Stage::Fresh {
                match validate_path(&a.path) {
                    Ok(clean) => a.path = clean,
                    Err(msg) => {
                        set_text(a, IDC_ERROR, msg);
                        return;
                    }
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
                // No dialog boxes: show the address inline instead.
                set_text(a, IDC_HINT, "github.com/Toluwer/Fleet/releases");
            }
        }
        IDC_CHECK_DESKTOP => {
            a.desktop_shortcut = !a.desktop_shortcut;
            if let Some(w) = a.widgets.iter_mut().find(|w| w.id == IDC_CHECK_DESKTOP) {
                if let WgKind::Check { checked, .. } = &mut w.kind {
                    *checked = a.desktop_shortcut;
                }
            }
            render_present(a);
        }
        IDC_CHECK_DATA => {
            a.delete_data = !a.delete_data;
            if let Some(w) = a.widgets.iter_mut().find(|w| w.id == IDC_CHECK_DATA) {
                if let WgKind::Check { checked, .. } = &mut w.kind {
                    *checked = a.delete_data;
                }
            }
            render_present(a);
        }
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
                activate(a, IDC_INSTALL);
            }
        }
        Stage::UpdateReady => activate(a, IDC_INSTALL),
        Stage::UpToDate | Stage::Done | Stage::Uninstalled => fade_quit(a),
        Stage::UninstallConfirm => activate(a, IDC_REMOVE),
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
            Msg::File(f) => set_text(a, IDC_FILE, &f),
            Msg::Bytes(done, total) => {
                set_progress(a, done, total);
                set_text(a, IDC_BYTES, &format!("{} of {}", mb(done), mb(total)));
            }
            Msg::Note(n) => set_text(a, IDC_SUB, &n),
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

fn set_text(a: &mut App, id: i32, text: &str) {
    if let Some(w) = a.widgets.iter_mut().find(|w| w.id == id) {
        if let WgKind::Text { text: t, .. } = &mut w.kind {
            *t = text.to_string();
            render_present(a);
        }
    }
}

fn set_progress(a: &mut App, done: u64, total: u64) {
    a.progress = if total == 0 {
        1.0
    } else {
        (done as f64 / total as f64).clamp(0.0, 1.0) as f32
    };
    render_present(a);
}

// ------------------------------------------------------------------ entry

fn main() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        // GDI+ draws the entire window.
        let mut gptoken: usize = 0;
        let gpinput = GdiplusStartupInput {
            GdiplusVersion: 1,
            DebugEventCallback: 0,
            SuppressBackgroundThread: windows::core::BOOL::default(),
            SuppressExternalCodecs: windows::core::BOOL::default(),
        };
        if GdiplusStartup(&mut gptoken, &gpinput, std::ptr::null_mut()) != Status(0) {
            return;
        }

        let hinst: HINSTANCE = GetModuleHandleW(None).expect("module handle").into();
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

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
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(std::ptr::null_mut()),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: w!("FleetSetupWindow"),
        };
        let _ = RegisterClassW(&wc);

        let uninstall = std::env::args().skip(1).any(|arg| {
            let l = arg.to_ascii_lowercase();
            l == "--uninstall" || l == "/uninstall"
        }) || !Package::exists();
        let title = if uninstall { UNINSTALL_TITLE } else { APP_TITLE };

        // Borderless layered window: the shape comes from our alpha channel.
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED,
            w!("FleetSetupWindow"),
            PCWSTR(to_wide(title).as_ptr()),
            WS_POPUP,
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

        if let Some(a) = app_from(hwnd) {
            size_window(a);
            rebuild_canvas(a);
            build_stage(a);
            if a.resolving {
                start_resolve(a);
            }
            // Draw once at zero opacity, show, then fade in.
            canvas_present(a, 0);
            let _ = ShowWindow(hwnd, SW_SHOW);
            start_fade(a, 255, 350, After::None);
        }

        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 <= 0 {
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
