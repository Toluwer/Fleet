// Fleet installer build script.
//
// 1. Resolves the Fleet version (FLEET_VERSION env wins, else CARGO_PKG_VERSION).
// 2. Embeds the icon and the visual-styles manifest as PE resources so the
//    installer gets REAL native themed controls (comctl32 v6) and a real icon:
//      - windows-gnu  -> windres (target-prefixed, then plain)
//      - windows-msvc -> rc.exe (env RC, PATH, then Windows Kits)
//    When no resource compiler is available the build still succeeds; the app
//    then falls back to a runtime activation context for visual styles.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    println!("cargo:rerun-if-changed=icon.ico");
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-env-changed=FLEET_VERSION");

    // Version banner
    let version = env::var("FLEET_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into()));
    let banner = version.split('.').next_back().map(|_| version.clone());
    let _ = banner;
    println!("cargo:rustc-env=FLEET_VERSION={version}");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));

    // Stage manifest next to the rc file with the real version baked in.
    let manifest = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="Toluwa.Fleet.Setup" version="{v}.0" processorArchitecture="*"/>
  <description>Fleet setup</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}}"/>
      <supportedOS Id="{{1f676c76-80e1-4239-95bb-83d0f6d0da78}}"/>
    </application>
  </compatibility>
  <asmv3:application xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
    <asmv3:windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </asmv3:windowsSettings>
  </asmv3:application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        v = version
    );
    fs::write(out_dir.join("app.manifest"), manifest).expect("write manifest");

    // Copy the icon beside the rc file so resource paths stay relative.
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    fs::copy(src_dir.join("icon.ico"), out_dir.join("icon.ico")).expect("copy icon.ico");

    let rc = "1 ICON \"icon.ico\"\r\n1 24 \"app.manifest\"\r\n";
    fs::write(out_dir.join("resources.rc"), rc).expect("write resources.rc");

    let is_gnu = target.contains("windows-gnu");
    let resource = if is_gnu {
        compile_with_windres(&out_dir)
    } else {
        compile_with_rc(&out_dir)
    };

    match resource {
        Some(res) => println!("cargo:rustc-link-arg={}", res.display()),
        None => {
            println!("cargo:rustc-cfg=no_embedded_resources");
            eprintln!("fleet-setup: no resource compiler found; relying on runtime visual styles");
        }
    }
}

fn compile_with_windres(out_dir: &Path) -> Option<PathBuf> {
    let target = env::var("TARGET").unwrap_or_default();
    let prefix = if target.starts_with("x86_64") {
        "x86_64-w64-mingw32-"
    } else if target.starts_with("i686") {
        "i686-w64-mingw32-"
    } else {
        ""
    };
    let candidates: Vec<String> = if let Ok(w) = env::var("WINDRES") {
        vec![w]
    } else {
        vec![format!("{prefix}windres"), "windres".into()]
    };

    let obj = out_dir.join("resources.o");
    for tool in candidates {
        let ok = Command::new(&tool)
            .current_dir(out_dir)
            .args(["--input", "resources.rc"])
            .arg("--output").arg(obj.as_os_str())
            .arg("-O").arg("coff")
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(obj);
        }
    }
    None
}

fn compile_with_rc(out_dir: &Path) -> Option<PathBuf> {
    let res = out_dir.join("resources.res");
    let mut tool: Option<PathBuf> = None;

    if let Ok(rc) = env::var("RC") {
        tool = Some(PathBuf::from(rc));
    }
    if tool.is_none() {
        tool = which_rc_from_path();
    }
    if tool.is_none() {
        tool = find_windows_kits_rc();
    }

    let tool = tool?;
    let ok = Command::new(&tool)
        .current_dir(out_dir)
        .arg("/nologo")
        .arg("/fo").arg(res.as_os_str())
        .arg("resources.rc")
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok { Some(res) } else { None }
}

fn which_rc_from_path() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join("rc.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_windows_kits_rc() -> Option<PathBuf> {
    let roots = [
        PathBuf::from(r"C:\Program Files (x86)\Windows Kits\10\bin"),
        PathBuf::from(r"C:\Program Files\Windows Kits\10\bin"),
    ];
    let mut best: Option<PathBuf> = None;
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let arch_dir = entry.path().join("x64").join("rc.exe");
            if arch_dir.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                let better = best.as_ref().map(|b| {
                    b.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default() < name
                }).unwrap_or(true);
                if better {
                    best = Some(arch_dir);
                }
            }
        }
    }
    best
}
