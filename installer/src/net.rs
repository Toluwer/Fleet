// The installer's link to github.com.
//
// An installer exe is only as new as the day it was downloaded, which used to
// mean "run an old installer, get the old version". Now every installer
// checks the release feed first and, when a newer version is published,
// downloads THAT release's portable package and installs it instead of its
// own embedded payload. So a FleetInstaller.exe from months ago still puts
// the newest Fleet on the machine.
//
// Uses WinHTTP (the same Windows component Windows Update rides on): native
// TLS, no extra process, no script host, no temp files, and it honors the
// machine's proxy configuration. The response stays in memory - the payload
// path ("extract straight from the exe bytes") already worked that way.

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpCrackUrl, WinHttpOpen, WinHttpOpenRequest,
    WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, URL_COMPONENTS, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
    WINHTTP_FLAG_SECURE, WINHTTP_OPEN_REQUEST_FLAGS, WINHTTP_QUERY_CONTENT_LENGTH,
    WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
};

/// Everything the installer needs from latest.yml to fetch a newer release.
#[derive(Clone)]
pub struct Latest {
    pub version: String,
    pub zip_name: String,
    pub sha512_b64: String,
    pub size: u64,
}

const RELEASES_BASE: &str = "https://github.com/Toluwer/Fleet/releases/latest/download";
const FEED_URL: &str = "https://github.com/Toluwer/Fleet/releases/latest/download/latest.yml";
const MAX_DOWNLOAD: usize = 256 * 1024 * 1024;

/// Fetches and parses latest.yml. Errors carry a plain-language cause; the
/// caller decides whether that is fatal (we are mid-download) or just means
/// "stay with the embedded payload".
pub fn fetch_latest() -> Result<Latest, String> {
    let text = http_get(FEED_URL, &mut |_, _| {})?;
    let body = String::from_utf8_lossy(&text).to_string();
    parse_latest_yml(&body).ok_or_else(|| "The release feed could not be read.".to_string())
}

/// GET -> bytes. `on_progress(done, total)` is called as data arrives; total
/// is 0 when the server did not announce a length.
pub fn http_get(url: &str, on_progress: &mut dyn FnMut(u64, u64)) -> Result<Vec<u8>, String> {
    // Split the URL with the OS, not string surgery.
    let wide: Vec<u16> = url.encode_utf16().collect();
    let mut host = [0u16; 256];
    let mut path = [0u16; 2048];
    let mut comp = URL_COMPONENTS {
        dwStructSize: std::mem::size_of::<URL_COMPONENTS>() as u32,
        lpszHostName: PWSTR(host.as_mut_ptr()),
        dwHostNameLength: host.len() as u32,
        lpszUrlPath: PWSTR(path.as_mut_ptr()),
        dwUrlPathLength: path.len() as u32,
        ..Default::default()
    };
    unsafe { WinHttpCrackUrl(&wide, 0, &mut comp) }
        .map_err(|e| format!("The release address could not be parsed: {e}"))?;
    let host_len = (comp.dwHostNameLength as usize).min(host.len());
    let path_len = (comp.dwUrlPathLength as usize).min(path.len());
    let host_str = String::from_utf16_lossy(&host[..host_len]);
    let path_str = String::from_utf16_lossy(&path[..path_len]);
    let secure = url.starts_with("https:");

    let host_wide = to_wide(&host_str);
    let path_wide = to_wide(&path_str);

    unsafe {
        let session = WinHttpOpen(
            w!("Fleet-Setup"),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return Err("Could not reach the network (WinHttpOpen failed).".into());
        }
        let guard_session = Handle(session);
        WinHttpSetTimeouts(session, 5000, 10_000, 10_000, 30_000)
            .map_err(|e| format!("Could not configure the connection: {e}"))?;

        let connect = WinHttpConnect(session, PCWSTR(host_wide.as_ptr()), comp.nPort, 0);
        if connect.is_null() {
            return Err(format!("Could not connect to {host_str}."));
        }
        let guard_connect = Handle(connect);

        let flags = if secure { WINHTTP_FLAG_SECURE } else { WINHTTP_OPEN_REQUEST_FLAGS(0) };
        let request = WinHttpOpenRequest(
            connect,
            w!("GET"),
            PCWSTR(path_wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            flags,
        );
        if request.is_null() {
            return Err("Could not open the request.".into());
        }
        let guard_request = Handle(request);

        WinHttpSendRequest(request, None, None, 0, 0, 0)
            .map_err(|e| format!("The request could not be sent: {e}"))?;
        WinHttpReceiveResponse(request, std::ptr::null_mut())
            .map_err(|e| format!("The server did not answer: {e}"))?;

        let mut status: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let mut index: u32 = 0;
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut core::ffi::c_void),
            &mut size,
            &mut index,
        )
        .map_err(|e| format!("The server response could not be read: {e}"))?;
        if status != 200 {
            return Err(format!("The server returned HTTP {status} for the download."));
        }

        let mut total: u32 = 0;
        size = std::mem::size_of::<u32>() as u32;
        index = 0;
        let _ = WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut total as *mut u32 as *mut core::ffi::c_void),
            &mut size,
            &mut index,
        );

        let mut out: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut avail: u32 = 0;
            WinHttpQueryDataAvailable(request, &mut avail)
                .map_err(|e| format!("The connection dropped: {e}"))?;
            if avail == 0 {
                break;
            }
            let want = avail.min(buf.len() as u32);
            let mut read: u32 = 0;
            WinHttpReadData(request, buf.as_mut_ptr() as *mut core::ffi::c_void, want, &mut read)
                .map_err(|e| format!("The download was interrupted: {e}"))?;
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
            if out.len() > MAX_DOWNLOAD {
                return Err("The download is far larger than any Fleet release - aborted.".into());
            }
            on_progress(out.len() as u64, total as u64);
        }
        drop(guard_request);
        drop(guard_connect);
        drop(guard_session);
        Ok(out)
    }
}

/// Closes a WinHTTP handle exactly once, on every path (including panics).
struct Handle(*mut core::ffi::c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Tiny latest.yml reader: the feed is a flat `key: value` list, so a line
/// scanner is all that is warranted (no YAML dependency for 4 fields).
fn parse_latest_yml(text: &str) -> Option<Latest> {
    let mut version: Option<String> = None;
    let mut zip_name: Option<String> = None;
    let mut sha512_b64: Option<String> = None;
    let mut size: u64 = 0;
    for raw in text.lines() {
        let line = raw.trim();
        let value = |prefix: &str| -> Option<String> {
            line.strip_prefix(prefix).map(|v| {
                v.trim()
                    .trim_start_matches('\'')
                    .trim_end_matches('\'')
                    .trim_start_matches('"')
                    .trim_end_matches('"')
                    .to_string()
            })
        };
        if line.starts_with("version:") {
            version = value("version:");
        } else if line.starts_with("portableUrl:") {
            zip_name = value("portableUrl:");
        } else if line.starts_with("portableSha512:") {
            sha512_b64 = value("portableSha512:");
        } else if line.starts_with("portableSize:") {
            size = value("portableSize:").and_then(|v| v.parse().ok()).unwrap_or(0);
        }
    }
    Some(Latest {
        version: version?,
        zip_name: zip_name?,
        sha512_b64: sha512_b64?,
        size,
    })
}

/// Standard-alphabet base64 decode (padding ignored) for digest comparison.
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut reverse = [255u8; 256];
    for (i, &c) in ALPHABET.iter().enumerate() {
        reverse[c as usize] = i as u8;
    }
    let clean: Vec<u8> = s
        .bytes()
        .filter(|b| !b" \t\r\n".contains(b) && *b != b'=')
        .collect();
    let mut out = Vec::with_capacity(clean.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in clean.iter() {
        let v = reverse[b as usize];
        if v == 255 {
            return Err(format!("bad base64 character 0x{b:02x}"));
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// Verifies the downloaded package against the feed's sha512 (base64 form).
pub fn sha512_matches(data: &[u8], expected_b64: &str) -> bool {
    use sha2::{Digest, Sha512};
    let Ok(expected) = b64_decode(expected_b64.trim()) else {
        return false;
    };
    if expected.len() != 64 {
        return false;
    }
    let digest = Sha512::digest(data);
    digest.as_slice() == expected.as_slice()
}

/// Full URL of a release asset by its file name (for tests + the installer).
pub fn asset_url(name: &str) -> String {
    format!("{RELEASES_BASE}/{name}")
}
