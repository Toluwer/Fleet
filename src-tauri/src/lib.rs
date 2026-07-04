use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ROBLOX_LOGIN_URL: &str = "https://www.roblox.com/login";
const ROBLOX_COOKIE_URL: &str = "https://www.roblox.com/";
const LOGIN_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

#[derive(Serialize, Deserialize)]
struct RpcRequest {
    id: u64,
    command: String,
    payload: Value,
}

#[derive(Serialize, Deserialize)]
struct RpcEnvelope {
    id: Option<u64>,
    ok: Option<bool>,
    result: Option<Value>,
    error: Option<String>,
    event: Option<String>,
    payload: Option<Value>,
}

struct NodeBackend {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl NodeBackend {
    fn start(app: &AppHandle) -> Result<Self, String> {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()));
        let resource_dir = app.path().resource_dir().ok();
        let mut candidates = Vec::new();
        if let Some(dir) = exe_dir.as_ref() {
            candidates.push(dir.join("src").join("main").join("tauri-node-host.js"));
            candidates.push(dir.join("_up_").join("src").join("main").join("tauri-node-host.js"));
        }
        if let Some(dir) = resource_dir {
            candidates.push(dir.join("src").join("main").join("tauri-node-host.js"));
            candidates.push(dir.join("_up_").join("src").join("main").join("tauri-node-host.js"));
        }
        candidates.push(cwd.join("src").join("main").join("tauri-node-host.js"));
        let script = candidates
            .into_iter()
            .find(|path| path.exists())
            .ok_or_else(|| "Could not locate the Fleet Tauri backend host script.".to_string())?;
        let node = exe_dir
            .as_ref()
            .map(|dir| dir.join("node.exe"))
            .filter(|path| path.exists())
            .or_else(|| {
                exe_dir
                    .as_ref()
                    .map(|dir| dir.join("resources").join("node.exe"))
                    .filter(|path| path.exists())
            })
            .or_else(|| {
                app.path()
                    .resource_dir()
                    .ok()
                    .map(|dir| dir.join("node.exe"))
                    .filter(|path| path.exists())
            })
            .or_else(|| {
                app.path()
                    .resource_dir()
                    .ok()
                    .map(|dir| dir.join("resources").join("node.exe"))
                    .filter(|path| path.exists())
            })
            .unwrap_or_else(|| PathBuf::from("node"));
        let mut command = Command::new(node);
        command
            .arg(script)
            .arg(app.package_info().version.to_string())
            .arg(app.path().app_data_dir().map_err(|e| e.to_string())?.display().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|e| format!("Failed to spawn node backend: {e}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "Node backend stdin unavailable".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "Node backend stdout unavailable".to_string())?;
        Ok(Self { child, stdin, stdout: BufReader::new(stdout), next_id: 1 })
    }

    fn invoke(&mut self, command: &str, payload: Value, app: &AppHandle) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let request = RpcRequest { id, command: command.to_string(), payload };
        let mut line = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        line.push(b'\n');
        self.stdin.write_all(&line).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        loop {
            let mut buf = String::new();
            let read = self.stdout.read_line(&mut buf).map_err(|e| e.to_string())?;
            if read == 0 {
                return Err("Node backend closed unexpectedly".to_string());
            }
            let envelope: RpcEnvelope = serde_json::from_str(buf.trim()).map_err(|e| e.to_string())?;
            if let Some(event) = envelope.event {
                let payload = envelope.payload.unwrap_or(Value::Null);
                let _ = app.emit(&event, payload);
                continue;
            }
            if envelope.id == Some(id) {
                if envelope.ok == Some(true) {
                    return Ok(envelope.result.unwrap_or(Value::Null));
                }
                return Err(envelope.error.unwrap_or_else(|| "Unknown backend error".to_string()));
            }
        }
    }

    fn shutdown(&mut self) {
        let request = RpcRequest { id: 0, command: "shutdown".to_string(), payload: Value::Null };
        if let Ok(mut line) = serde_json::to_vec(&request) {
            line.push(b'\n');
            let _ = self.stdin.write_all(&line);
            let _ = self.stdin.flush();
        }
        let _ = self.child.kill();
    }
}

struct FleetState {
    backend: Mutex<Option<NodeBackend>>,
}

impl FleetState {
    fn invoke(&self, app: &AppHandle, command: &str, payload: Value) -> Value {
        let mut guard = match self.backend.lock() {
            Ok(guard) => guard,
            Err(_) => return json!({ "ok": false, "error": "Backend state lock poisoned" }),
        };
        let backend = match guard.as_mut() {
            Some(backend) => backend,
            None => return json!({ "ok": false, "error": "Backend not started" }),
        };
        match backend.invoke(command, payload, app) {
            Ok(value) => value,
            Err(err) => json!({ "ok": false, "error": err }),
        }
    }
}

#[tauri::command]
fn app_status(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "app_status", Value::Null) }
#[tauri::command]
fn roblox_detect(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "roblox_detect", Value::Null) }
#[tauri::command]
fn ui_titlebar(app: AppHandle, state: tauri::State<FleetState>, dark: Option<bool>) -> Value { state.invoke(&app, "ui_titlebar", json!({ "dark": dark })) }
#[tauri::command]
fn ui_clipboard(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "ui_clipboard", Value::Null) }
#[tauri::command]
fn updater_status(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "updater_status", Value::Null) }
#[tauri::command]
fn updater_check(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "updater_check", Value::Null) }
#[tauri::command]
fn updater_install(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "updater_install", Value::Null) }
#[tauri::command]
fn launch_quick(app: AppHandle, state: tauri::State<FleetState>, count: Option<i64>) -> Value { state.invoke(&app, "launch_quick", json!({ "count": count })) }
#[tauri::command]
fn launch_accounts(app: AppHandle, state: tauri::State<FleetState>, account_ids: Vec<String>, place_id: Option<String>) -> Value { state.invoke(&app, "launch_accounts", json!({ "accountIds": account_ids, "placeId": place_id })) }
#[tauri::command]
fn launch_join(app: AppHandle, state: tauri::State<FleetState>, account_ids: Vec<String>, place_id: Option<String>, game_id: Option<String>) -> Value { state.invoke(&app, "launch_join", json!({ "accountIds": account_ids, "placeId": place_id, "gameId": game_id })) }
#[tauri::command]
fn launch_join_person(app: AppHandle, state: tauri::State<FleetState>, account_id: Option<String>, target_user_id: Option<i64>) -> Value { state.invoke(&app, "launch_join_person", json!({ "accountId": account_id, "targetUserId": target_user_id })) }
#[tauri::command]
fn launch_join_person_multi(app: AppHandle, state: tauri::State<FleetState>, account_ids: Vec<String>, target_user_id: Option<i64>) -> Value { state.invoke(&app, "launch_join_person_multi", json!({ "accountIds": account_ids, "targetUserId": target_user_id })) }
#[tauri::command]
fn accounts_list(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "accounts_list", Value::Null) }
#[tauri::command]
async fn accounts_add(app: AppHandle, state: tauri::State<'_, FleetState>) -> Result<Value, String> {
    let label = format!(
        "roblox-login-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let url = match Url::parse(ROBLOX_LOGIN_URL) {
        Ok(url) => url,
        Err(err) => return Ok(json!({ "ok": false, "error": err.to_string() })),
    };
    let cookie_url = match Url::parse(ROBLOX_COOKIE_URL) {
        Ok(url) => url,
        Err(err) => return Ok(json!({ "ok": false, "error": err.to_string() })),
    };
    let data_dir = std::env::temp_dir().join(&label);
    let window = match WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title("Sign in to Roblox")
        .inner_size(520.0, 720.0)
        .min_inner_size(460.0, 560.0)
        .center()
        .focused(true)
        .user_agent(LOGIN_UA)
        .data_directory(data_dir.clone())
        .build()
    {
        Ok(window) => window,
        Err(err) => return Ok(json!({ "ok": false, "error": format!("Could not open Roblox sign-in window: {err}") })),
    };

    let started = Instant::now();
    let timeout = Duration::from_secs(10 * 60);
    let cookie = loop {
        if started.elapsed() > timeout {
            let _ = window.close();
            return Ok(json!({ "ok": false, "canceled": true, "error": "Roblox sign-in timed out." }));
        }
        if app.get_webview_window(&label).is_none() {
            return Ok(json!({ "ok": false, "canceled": true }));
        }
        match window.cookies_for_url(cookie_url.clone()) {
            Ok(cookies) => {
                if let Some(cookie) = cookies
                    .iter()
                    .find(|cookie| cookie.name() == ".ROBLOSECURITY" && cookie.value().len() > 100)
                {
                    break cookie.value().to_string();
                }
            }
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_millis(900));
    };

    let _ = window.close();
    let result = state.invoke(&app, "accounts_add_cookie", json!({ "cookie": cookie }));
    let _ = std::fs::remove_dir_all(data_dir);
    Ok(result)
}
#[tauri::command]
fn accounts_remove(app: AppHandle, state: tauri::State<FleetState>, id: Option<String>) -> Value { state.invoke(&app, "accounts_remove", json!({ "id": id })) }
#[tauri::command]
fn accounts_refresh(app: AppHandle, state: tauri::State<FleetState>, id: Option<String>, full: Option<bool>) -> Value { state.invoke(&app, "accounts_refresh", json!({ "id": id, "full": full })) }
#[tauri::command]
fn accounts_follow(app: AppHandle, state: tauri::State<FleetState>, target_account_id: Option<String>, follower_account_ids: Vec<String>) -> Value { state.invoke(&app, "accounts_follow", json!({ "targetAccountId": target_account_id, "followerAccountIds": follower_account_ids })) }
#[tauri::command]
fn games_browse(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "games_browse", Value::Null) }
#[tauri::command]
fn games_search(app: AppHandle, state: tauri::State<FleetState>, query: Option<String>, page_token: Option<String>) -> Value { state.invoke(&app, "games_search", json!({ "query": query, "pageToken": page_token })) }
#[tauri::command]
fn games_servers(app: AppHandle, state: tauri::State<FleetState>, place_id: Option<String>, cursor: Option<String>) -> Value { state.invoke(&app, "games_servers", json!({ "placeId": place_id, "cursor": cursor })) }
#[tauri::command]
fn games_server_scan(app: AppHandle, state: tauri::State<FleetState>, place_id: Option<String>, page_limit: Option<usize>) -> Value { state.invoke(&app, "games_server_scan", json!({ "placeId": place_id, "pageLimit": page_limit })) }
#[tauri::command]
fn people_list(app: AppHandle, state: tauri::State<FleetState>, page: Option<usize>, page_size: Option<usize>, force: Option<bool>) -> Value { state.invoke(&app, "people_list", json!({ "page": page, "pageSize": page_size, "force": force })) }
#[tauri::command]
fn people_server_list(app: AppHandle, state: tauri::State<FleetState>, force: Option<bool>) -> Value { state.invoke(&app, "people_server_list", json!({ "force": force })) }
#[tauri::command]
fn people_search(app: AppHandle, state: tauri::State<FleetState>, query: Option<String>, cursor: Option<String>) -> Value { state.invoke(&app, "people_search", json!({ "query": query, "cursor": cursor })) }
#[tauri::command]
fn people_profile(app: AppHandle, state: tauri::State<FleetState>, user_id: Option<i64>) -> Value { state.invoke(&app, "people_profile", json!({ "userId": user_id })) }
#[tauri::command]
fn people_presence(app: AppHandle, state: tauri::State<FleetState>, user_ids: Vec<i64>) -> Value { state.invoke(&app, "people_presence", json!({ "userIds": user_ids })) }
#[tauri::command]
fn instances_get(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "instances_get", Value::Null) }
#[tauri::command]
fn instance_focus(app: AppHandle, state: tauri::State<FleetState>, pid: Option<u32>) -> Value { state.invoke(&app, "instance_focus", json!({ "pid": pid })) }
#[tauri::command]
fn instance_kill(app: AppHandle, state: tauri::State<FleetState>, pid: Option<u32>) -> Value { state.invoke(&app, "instance_kill", json!({ "pid": pid })) }
#[tauri::command]
fn instance_restart(app: AppHandle, state: tauri::State<FleetState>, pid: Option<u32>) -> Value { state.invoke(&app, "instance_restart", json!({ "pid": pid })) }
#[tauri::command]
fn instances_kill_all(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "instances_kill_all", Value::Null) }
#[tauri::command]
fn instances_cleanup(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "instances_cleanup", Value::Null) }
#[tauri::command]
fn instances_arrange(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "instances_arrange", Value::Null) }
#[tauri::command]
fn playtime_stats(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "playtime_stats", Value::Null) }
#[tauri::command]
fn playtime_clear(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "playtime_clear", Value::Null) }
#[tauri::command]
fn history_get(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "history_get", Value::Null) }
#[tauri::command]
fn history_clear(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "history_clear", Value::Null) }
#[tauri::command]
fn settings_get(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "settings_get", Value::Null) }
#[tauri::command]
fn settings_save(app: AppHandle, state: tauri::State<FleetState>, partial: Value) -> Value { state.invoke(&app, "settings_save", json!({ "partial": partial })) }
#[tauri::command]
fn settings_reset(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "settings_reset", Value::Null) }
#[tauri::command]
fn settings_browse(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "settings_browse", Value::Null) }
#[tauri::command]
fn logs_get(app: AppHandle, state: tauri::State<FleetState>, limit: Option<usize>) -> Value { state.invoke(&app, "logs_get", json!({ "limit": limit })) }
#[tauri::command]
fn logs_clear(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "logs_clear", Value::Null) }
#[tauri::command]
fn logs_open_folder(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "logs_open_folder", Value::Null) }
#[tauri::command]
fn diag_get(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "diag_get", Value::Null) }
#[tauri::command]
fn app_open_external(app: AppHandle, state: tauri::State<FleetState>, url: Option<String>) -> Value { state.invoke(&app, "app_open_external", json!({ "url": url })) }
#[tauri::command]
fn app_open_user_data(app: AppHandle, state: tauri::State<FleetState>) -> Value { state.invoke(&app, "app_open_user_data", Value::Null) }

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let backend = NodeBackend::start(app.handle())?;
            app.manage(FleetState { backend: Mutex::new(Some(backend)) });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(state) = window.try_state::<FleetState>() {
                        if let Ok(mut guard) = state.backend.lock() {
                            if let Some(mut backend) = guard.take() {
                                backend.shutdown();
                            }
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            roblox_detect,
            ui_titlebar,
            ui_clipboard,
            updater_status,
            updater_check,
            updater_install,
            launch_quick,
            launch_accounts,
            launch_join,
            launch_join_person,
            launch_join_person_multi,
            accounts_list,
            accounts_add,
            accounts_remove,
            accounts_refresh,
            accounts_follow,
            games_browse,
            games_search,
            games_servers,
            games_server_scan,
            people_list,
            people_server_list,
            people_search,
            people_profile,
            people_presence,
            instances_get,
            instance_focus,
            instance_kill,
            instance_restart,
            instances_kill_all,
            instances_cleanup,
            instances_arrange,
            playtime_stats,
            playtime_clear,
            history_get,
            history_clear,
            settings_get,
            settings_save,
            settings_reset,
            settings_browse,
            logs_get,
            logs_clear,
            logs_open_folder,
            diag_get,
            app_open_external,
            app_open_user_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
