use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
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
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
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
            candidates.push(
                dir.join("_up_")
                    .join("src")
                    .join("main")
                    .join("tauri-node-host.js"),
            );
        }
        if let Some(dir) = resource_dir {
            candidates.push(dir.join("src").join("main").join("tauri-node-host.js"));
            candidates.push(
                dir.join("_up_")
                    .join("src")
                    .join("main")
                    .join("tauri-node-host.js"),
            );
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
            .arg(
                app.path()
                    .app_data_dir()
                    .map_err(|e| e.to_string())?
                    .display()
                    .to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to spawn node backend: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Node backend stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Node backend stdout unavailable".to_string())?;
        let pending = Arc::new(Mutex::new(HashMap::<
            u64,
            mpsc::Sender<Result<Value, String>>,
        >::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let reader_pending = Arc::clone(&pending);
        let reader_alive = Arc::clone(&alive);
        let reader_app = app.clone();
        thread::Builder::new()
            .name("fleet-backend-reader".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut buf = String::new();
                    match reader.read_line(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let envelope: RpcEnvelope = match serde_json::from_str(buf.trim()) {
                        Ok(envelope) => envelope,
                        Err(_) => continue,
                    };
                    if let Some(event) = envelope.event {
                        let _ = reader_app.emit(&event, envelope.payload.unwrap_or(Value::Null));
                        continue;
                    }
                    let Some(id) = envelope.id else { continue };
                    let sender = reader_pending
                        .lock()
                        .ok()
                        .and_then(|mut map| map.remove(&id));
                    if let Some(sender) = sender {
                        let result = if envelope.ok == Some(true) {
                            Ok(envelope.result.unwrap_or(Value::Null))
                        } else {
                            Err(envelope
                                .error
                                .unwrap_or_else(|| "Unknown backend error".to_string()))
                        };
                        let _ = sender.send(result);
                    }
                }
                reader_alive.store(false, Ordering::Release);
                if let Ok(mut map) = reader_pending.lock() {
                    for (_, sender) in map.drain() {
                        let _ = sender.send(Err("Node backend closed unexpectedly".to_string()));
                    }
                }
            })
            .map_err(|e| format!("Failed to start backend reader: {e}"))?;

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            alive,
        })
    }

    fn invoke_with_timeout(
        &self,
        command: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("Node backend is not running".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = RpcRequest {
            id,
            command: command.to_string(),
            payload,
        };
        let mut line = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "Backend response map poisoned".to_string())?
            .insert(id, sender);
        let write_result = self
            .stdin
            .lock()
            .map_err(|_| "Backend input lock poisoned".to_string())
            .and_then(|mut stdin| {
                stdin.write_all(&line).map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())
            });
        if let Err(err) = write_result {
            if let Ok(mut map) = self.pending.lock() {
                map.remove(&id);
            }
            return Err(err);
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&id);
                }
                Err(format!("Backend command '{command}' timed out"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Backend response channel closed".to_string())
            }
        }
    }

    fn invoke(&self, command: &str, payload: Value) -> Result<Value, String> {
        self.invoke_with_timeout(command, payload, Duration::from_secs(60))
    }

    fn shutdown(&self) {
        if self.alive.load(Ordering::Acquire) {
            let _ = self.invoke_with_timeout("shutdown", Value::Null, Duration::from_secs(4));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let exited = self
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten())
                .is_some();
            if exited {
                return;
            }
            thread::sleep(Duration::from_millis(40));
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct FleetState {
    backend: Mutex<Option<Arc<NodeBackend>>>,
}

impl FleetState {
    fn invoke(&self, command: &str, payload: Value) -> Value {
        let guard = match self.backend.lock() {
            Ok(guard) => guard,
            Err(_) => return json!({ "ok": false, "error": "Backend state lock poisoned" }),
        };
        let backend = match guard.as_ref().cloned() {
            Some(backend) => backend,
            None => return json!({ "ok": false, "error": "Backend not started" }),
        };
        drop(guard);
        match backend.invoke(command, payload) {
            Ok(value) => value,
            Err(err) => json!({ "ok": false, "error": err }),
        }
    }
}

async fn invoke_backend(app: AppHandle, command: &'static str, payload: Value) -> Value {
    let task_app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let state = task_app.state::<FleetState>();
        state.invoke(command, payload)
    })
    .await
    {
        Ok(value) => value,
        Err(err) => json!({ "ok": false, "error": format!("Backend task failed: {err}") }),
    }
}

macro_rules! backend_command {
    ($name:ident, $command:literal, ($($arg:ident: $ty:ty),*), $payload:expr) => {
        #[tauri::command]
        async fn $name(app: AppHandle, $($arg: $ty),*) -> Value {
            invoke_backend(app, $command, $payload).await
        }
    };
}

backend_command!(app_status, "app_status", (), Value::Null);
backend_command!(roblox_detect, "roblox_detect", (), Value::Null);
backend_command!(updater_status, "updater_status", (), Value::Null);
backend_command!(updater_check, "updater_check", (), Value::Null);
backend_command!(updater_install, "updater_install", (), Value::Null);
backend_command!(launch_quick, "launch_quick", (count: Option<i64>), json!({ "count": count }));
backend_command!(launch_accounts, "launch_accounts", (account_ids: Vec<String>, place_id: Option<String>), json!({ "accountIds": account_ids, "placeId": place_id }));
backend_command!(launch_join, "launch_join", (account_ids: Vec<String>, place_id: Option<String>, game_id: Option<String>), json!({ "accountIds": account_ids, "placeId": place_id, "gameId": game_id }));
backend_command!(launch_join_person, "launch_join_person", (account_id: Option<String>, target_user_id: Option<i64>), json!({ "accountId": account_id, "targetUserId": target_user_id }));
backend_command!(launch_join_person_multi, "launch_join_person_multi", (account_ids: Vec<String>, target_user_id: Option<i64>), json!({ "accountIds": account_ids, "targetUserId": target_user_id }));
backend_command!(accounts_list, "accounts_list", (), Value::Null);
#[tauri::command]
async fn accounts_add(app: AppHandle) -> Result<Value, String> {
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
        Err(err) => {
            return Ok(
                json!({ "ok": false, "error": format!("Could not open Roblox sign-in window: {err}") }),
            )
        }
    };

    let started = Instant::now();
    let timeout = Duration::from_secs(10 * 60);
    let cookie = loop {
        if started.elapsed() > timeout {
            let _ = window.close();
            return Ok(
                json!({ "ok": false, "canceled": true, "error": "Roblox sign-in timed out." }),
            );
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
        tokio::time::sleep(Duration::from_millis(900)).await;
    };

    let _ = window.close();
    let result = invoke_backend(
        app.clone(),
        "accounts_add_cookie",
        json!({ "cookie": cookie }),
    )
    .await;
    let _ = std::fs::remove_dir_all(data_dir);
    Ok(result)
}
backend_command!(accounts_remove, "accounts_remove", (id: Option<String>), json!({ "id": id }));
backend_command!(accounts_refresh, "accounts_refresh", (id: Option<String>, full: Option<bool>), json!({ "id": id, "full": full }));
backend_command!(accounts_follow, "accounts_follow", (target_account_id: Option<String>, follower_account_ids: Vec<String>), json!({ "targetAccountId": target_account_id, "followerAccountIds": follower_account_ids }));
backend_command!(games_browse, "games_browse", (), Value::Null);
backend_command!(games_search, "games_search", (query: Option<String>, page_token: Option<String>), json!({ "query": query, "pageToken": page_token }));
backend_command!(games_servers, "games_servers", (place_id: Option<String>, cursor: Option<String>), json!({ "placeId": place_id, "cursor": cursor }));
backend_command!(games_server_scan, "games_server_scan", (place_id: Option<String>, page_limit: Option<usize>), json!({ "placeId": place_id, "pageLimit": page_limit }));
backend_command!(people_list, "people_list", (page: Option<usize>, page_size: Option<usize>, force: Option<bool>), json!({ "page": page, "pageSize": page_size, "force": force }));
backend_command!(people_search, "people_search", (query: Option<String>, cursor: Option<String>), json!({ "query": query, "cursor": cursor }));
backend_command!(people_profile, "people_profile", (user_id: Option<i64>), json!({ "userId": user_id }));
backend_command!(people_presence, "people_presence", (user_ids: Vec<i64>), json!({ "userIds": user_ids }));
backend_command!(instances_get, "instances_get", (), Value::Null);
backend_command!(instance_focus, "instance_focus", (pid: Option<u32>), json!({ "pid": pid }));
backend_command!(instance_kill, "instance_kill", (pid: Option<u32>), json!({ "pid": pid }));
backend_command!(instance_restart, "instance_restart", (pid: Option<u32>), json!({ "pid": pid }));
backend_command!(instances_kill_all, "instances_kill_all", (), Value::Null);
backend_command!(instances_cleanup, "instances_cleanup", (), Value::Null);
backend_command!(instances_arrange, "instances_arrange", (), Value::Null);
backend_command!(playtime_stats, "playtime_stats", (), Value::Null);
backend_command!(playtime_clear, "playtime_clear", (), Value::Null);
backend_command!(history_get, "history_get", (), Value::Null);
backend_command!(history_clear, "history_clear", (), Value::Null);
backend_command!(settings_get, "settings_get", (), Value::Null);
backend_command!(settings_save, "settings_save", (partial: Value), json!({ "partial": partial }));
backend_command!(settings_reset, "settings_reset", (), Value::Null);
backend_command!(settings_browse, "settings_browse", (), Value::Null);
backend_command!(logs_get, "logs_get", (limit: Option<usize>), json!({ "limit": limit }));
backend_command!(logs_clear, "logs_clear", (), Value::Null);
backend_command!(logs_open_folder, "logs_open_folder", (), Value::Null);
backend_command!(diag_get, "diag_get", (), Value::Null);
backend_command!(app_open_external, "app_open_external", (url: Option<String>), json!({ "url": url }));
backend_command!(app_open_user_data, "app_open_user_data", (), Value::Null);

pub fn run() {
    let mut context = tauri::generate_context!();
    #[cfg(windows)]
    if let Ok(browser_args) = std::env::var("FLEET_UI_TEST_BROWSER_ARGS") {
        if let Some(window) = context.config_mut().app.windows.first_mut() {
            window.additional_browser_args = Some(browser_args);
            window.devtools = Some(true);
            if let Ok(data_directory) = std::env::var("FLEET_UI_TEST_DATA_DIRECTORY") {
                window.data_directory = Some(data_directory.into());
            }
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            let backend = NodeBackend::start(app.handle())?;
            app.manage(FleetState {
                backend: Mutex::new(Some(Arc::new(backend))),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(state) = window.try_state::<FleetState>() {
                        if let Ok(mut guard) = state.backend.lock() {
                            if let Some(backend) = guard.take() {
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
        .run(context)
        .expect("error while running tauri application");
}
