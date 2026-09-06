// Self-extracting payload: a plain ZIP archive appended to the installer exe.
//
// Layout on disk:   [ exe bytes ][ zip bytes ][ 8-byte magic ][ u64 zip start ]
//
// The ZIP itself is produced by PowerShell's Compress-Archive (or any zip
// tool), so the parser tolerates both '/' and '\' entry separators, explicit
// directory entries and stored/deflate members.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const TRAILER_MAGIC: &[u8; 8] = b"FLEETSTP";
const TRAILER_LEN: usize = 16;

pub struct Package {
    data: Vec<u8>,
}

pub struct Entry {
    pub name: String,
    pub method: u16,
    pub csize: u64,
    pub raw_size: u64,
    pub is_dir: bool,
    local_header: u64,
}

pub struct Progress<'a> {
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub file: &'a str,
}

impl Package {
    /// Cheap payload check: reads only the 16-byte trailer.
    pub fn exists() -> bool {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return false,
        };
        let mut f = match fs::File::open(&exe) {
            Ok(f) => f,
            Err(_) => return false,
        };
        let len = match f.metadata() {
            Ok(m) => m.len(),
            Err(_) => return false,
        };
        if len < TRAILER_LEN as u64 + 22 {
            return false;
        }
        use std::io::Seek;
        if f.seek(SeekFrom::Start(len - TRAILER_LEN as u64)).is_err() {
            return false;
        }
        let mut trailer = [0u8; TRAILER_LEN];
        if f.read_exact(&mut trailer).is_err() {
            return false;
        }
        if &trailer[0..8] != TRAILER_MAGIC {
            return false;
        }
        let start = u64::from_le_bytes(trailer[8..16].try_into().unwrap());
        start > 0 && start + TRAILER_LEN as u64 <= len
    }

    /// Opens the payload from the running executable. Returns `None` when this
    /// copy carries no payload (e.g. the bare `uninstall.exe`).
    pub fn open() -> Option<Package> {
        let exe = std::env::current_exe().ok()?;
        let mut f = fs::File::open(&exe).ok()?;
        let len = f.metadata().ok()?.len() as usize;
        if len < TRAILER_LEN + 22 {
            return None;
        }
        f.seek(SeekFrom::Start((len - TRAILER_LEN) as u64)).ok()?;
        let mut trailer = [0u8; TRAILER_LEN];
        f.read_exact(&mut trailer).ok()?;
        if &trailer[0..8] != TRAILER_MAGIC {
            return None;
        }
        let start = u64::from_le_bytes(trailer[8..16].try_into().unwrap()) as usize;
        if start == 0 || start + TRAILER_LEN > len {
            return None;
        }
        let zip_len = len - TRAILER_LEN - start;
        let mut data = vec![0u8; zip_len];
        f.seek(SeekFrom::Start(start as u64)).ok()?;
        f.read_exact(&mut data).ok()?;
        Some(Package { data })
    }

    fn eocd(&self) -> Option<usize> {
        // Scan backwards for the End Of Central Directory record.
        const SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
        let max = self.data.len().checked_sub(22)?;
        let min = self.data.len().saturating_sub(22 + 65_535);
        let mut i = max;
        loop {
            if self.data[i..i + 4] == SIG && i + 20 <= self.data.len() {
                let comment_len = u16::from_le_bytes(
                    [self.data[i + 20], self.data[i + 21]],
                ) as usize;
                if i + 22 + comment_len == self.data.len() {
                    return Some(i);
                }
            }
            if i == min {
                return None;
            }
            i -= 1;
        }
    }

    pub fn entries(&self) -> Result<Vec<Entry>, String> {
        let eocd = self.eocd().ok_or("payload: no zip directory found")?;
        let d = &self.data;
        let rd16 = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
        let rd32 = |o: usize| {
            u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]) as usize
        };

        let count = rd16(eocd + 10);
        let cd_size = rd32(eocd + 12);
        let cd_off = rd32(eocd + 16);
        if cd_off + cd_size > self.data.len() {
            return Err("payload: zip directory out of range".into());
        }

        let mut out = Vec::with_capacity(count);
        let mut p = cd_off;
        for _ in 0..count {
            if p + 46 > d.len() || d[p..p + 4] != [0x50, 0x4b, 0x01, 0x02] {
                return Err("payload: corrupt zip directory".into());
            }
            let method = rd16(p + 10) as u16;
            let csize = rd32(p + 20) as u64;
            let raw_size = rd32(p + 24) as u64;
            let name_len = rd16(p + 28);
            let extra_len = rd16(p + 30);
            let comment_len = rd16(p + 32);
            let ext_attr = rd32(p + 38);
            let lho = rd32(p + 42) as u64;
            if csize == 0xFFFF_FFFF || raw_size == 0xFFFF_FFFF {
                return Err("payload: zip64 archives are not supported".into());
            }
            let name_bytes = &d[p + 46..p + 46 + name_len];
            let mut name = String::from_utf8_lossy(name_bytes).to_string();
            name = name.replace('\\', "/");
            while name.starts_with("./") {
                name.remove(0);
                name.remove(0);
            }
            let is_dir = name.ends_with('/')
                || (raw_size == 0 && (ext_attr & 0x10) != 0);
            if name.is_empty() {
                return Err("payload: empty entry name".into());
            }
            out.push(Entry { name, method, csize, raw_size, is_dir, local_header: lho });
            p += 46 + name_len + extra_len + comment_len;
        }
        Ok(out)
    }

    fn entry_bytes(&self, e: &Entry) -> Result<Vec<u8>, String> {
        let d = &self.data;
        let lho = e.local_header as usize;
        if lho + 30 > d.len() || d[lho..lho + 4] != [0x50, 0x4b, 0x03, 0x04] {
            return Err("payload: corrupt zip entry header".into());
        }
        let name_len = u16::from_le_bytes([d[lho + 26], d[lho + 27]]) as usize;
        let extra_len = u16::from_le_bytes([d[lho + 28], d[lho + 29]]) as usize;
        let start = lho + 30 + name_len + extra_len;
        let end = start + e.csize as usize;
        if end > d.len() {
            return Err("payload: truncated zip entry".into());
        }
        let raw = &d[start..end];
        match e.method {
            0 => Ok(raw.to_vec()),
            8 => {
                let limit = e.raw_size as usize;
                miniz_oxide::inflate::decompress_to_vec_with_limit(raw, limit)
                    .map_err(|_| format!("payload: could not decompress {}", e.name))
            }
            m => Err(format!("payload: unsupported compression method {m}")),
        }
    }

    /// Extracts everything into `dest`. Every file - including the optional
    /// WebView2 bootstrapper - lands in the destination folder; nothing is ever
    /// written to or executed from the temp directory (a classic dropper
    /// heuristic antivirus engines score heavily).
    pub fn extract(
        &self,
        entries: &[Entry],
        dest: &Path,
        mut progress: impl FnMut(Progress),
    ) -> Result<(), String> {
        let total: u64 = entries.iter().map(|e| e.raw_size).sum();
        let mut done: u64 = 0;

        for e in entries {
            if e.is_dir {
                let dir = safe_join(dest, &e.name)?;
                fs::create_dir_all(&dir).map_err(|err| {
                    format!("could not create folder {}\n{}", dir.display(), err)
                })?;
                continue;
            }
            let data = self.entry_bytes(e)?;
            let target = safe_join(dest, &e.name)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|err| {
                    format!("could not create folder {}\n{}", parent.display(), err)
                })?;
            }
            fs::write(&target, &data).map_err(|err| {
                format!("could not write {}\n{}", target.display(), err)
            })?;
            done += e.raw_size;
            progress(Progress { done_bytes: done, total_bytes: total, file: &e.name });
        }
        Ok(())
    }
}

fn safe_join(root: &Path, name: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(format!("unsafe path in payload: {name}")),
            p if p.contains(':') => return Err(format!("unsafe path in payload: {name}")),
            p => {
                path.push(p);
            }
        }
    }
    Ok(path)
}

/// Appends `zip_path` to `exe_path`, producing the final self-extracting
/// installer at `out_path`. (Used by the build pipeline; also handy for tests.)
#[allow(dead_code)]
pub fn attach(exe_path: &Path, zip_path: &Path, out_path: &Path) -> Result<(), String> {
    let mut exe = fs::read(exe_path).map_err(|e| e.to_string())?;
    let zip = fs::read(zip_path).map_err(|e| e.to_string())?;
    let start = exe.len() as u64;
    exe.extend_from_slice(&zip);
    exe.extend_from_slice(TRAILER_MAGIC);
    exe.extend_from_slice(&start.to_le_bytes());
    fs::write(out_path, exe).map_err(|e| e.to_string())
}
