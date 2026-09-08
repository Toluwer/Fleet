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
const ROBLOX_SIGNUP_URL: &str = "https://www.roblox.com/CreateAccount";
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
backend_command!(launch_auto_fill, "launch_auto_fill", (account_ids: Vec<String>, place_id: Option<String>, spread: Option<bool>, keep_alive: Option<bool>, name: Option<String>), json!({ "accountIds": account_ids, "placeId": place_id, "spread": spread, "keepAlive": keep_alive, "name": name }));
backend_command!(keeper_arm, "keeper_arm", (records: Value), json!({ "records": records }));
backend_command!(keeper_disarm, "keeper_disarm", (account_id: Option<String>), json!({ "accountId": account_id }));
backend_command!(keeper_disarm_all, "keeper_disarm_all", (), Value::Null);
backend_command!(keeper_status, "keeper_status", (), Value::Null);
backend_command!(accounts_list, "accounts_list", (), Value::Null);
backend_command!(signup_check_username, "signup_check_username", (username: Option<String>, birthday: Option<String>), json!({ "username": username, "birthday": birthday }));
backend_command!(signup_suggest_usernames, "signup_suggest_usernames", (username: Option<String>, birthday: Option<String>), json!({ "username": username, "birthday": birthday }));
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

/// Roblox usernames: 3-20 chars, ASCII letters, digits, underscore.
const SIGNUP_USERNAME_MIN: usize = 3;
const SIGNUP_USERNAME_MAX: usize = 20;
const SIGNUP_PASSWORD_MIN: usize = 8;
const SIGNUP_PASSWORD_MAX: usize = 20;

/// The prefill driver for Roblox's real signup page. Roblox A/B tests the
/// form (a two-step wizard with Continue / "Add password" buttons, and a
/// classic single-step form with a Sign Up button), so the driver locates
/// fields by fingerprint instead of fixed ids: the username/password inputs
/// by several id/name/autocomplete patterns, the birthday selects by their
/// option values (never by document order), the gender by toggle buttons or
/// radios. It fills every field as soon as it appears (values set through
/// the native property setters + input/change events so React registers
/// them), re-fills anything a re-mount wipes, and advances the form toward
/// the captcha: one click when everything is valid, one retry for a
/// swallowed click, and after the captcha exactly one more click to finish
/// a trailing password step. The moment the user types or clicks anything,
/// every automatic action stops — the captcha itself is always theirs.
/// All user-supplied values arrive as one JSON object spliced into the
/// `__FLEET_VALS__` placeholder, so nothing can break out of the script.
/// The password lives only in memory (webview session) — it is never logged
/// or stored; the session cookie Roblox sets afterwards is what gets saved,
/// exactly like the sign-in flow.
const PREFILL_SCRIPT: &str = r#"(function() {
  if (window.__fleetPrefill) return;
  window.__fleetPrefill = true;
  var vals = __FLEET_VALS__;
  var dbg = { filled: { u: false, p: false, m: false, d: false, y: false, g: false },
              clickedAdvance: 0, captchaSeen: false, take: false, stopped: false, ticks: 0 };
  window.__fleetFill = dbg;
  try { console.log('[fleet-prefill] driver installed'); } catch (e) {}

  function onSignupPage() {
    try {
      var p = location.pathname.toLowerCase();
      return p.indexOf('createaccount') >= 0 || p.indexOf('create-account') >= 0 || p.indexOf('signup') >= 0;
    } catch (e) { return false; }
  }

  // Real user activity hands control back: typed input / real clicks on
  // controls stop every automatic action. Synthetic events (ours, React's)
  // carry isTrusted=false and never trigger this.
  var owned = new WeakSet();
  ['input', 'change'].forEach(function(type) {
    document.addEventListener(type, function(e) {
      var t = e.target;
      if (e.isTrusted && t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
        owned.add(t); dbg.take = true;
      }
    }, true);
  });
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (e.isTrusted && t && t.closest && t.closest('button, a, [role=button], input[type=radio], input[type=checkbox]')) dbg.take = true;
  }, true);

  function setNative(el, value) {
    var proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try {
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    } catch (e) { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Set a select by value, falling back to matching an option by value or
  // label prefix ("Jun" vs "June") so month-name style changes survive.
  function setSelect(select, value) {
    if (select.value === value) return true;
    setNative(select, value);
    if (select.value === value) return true;
    var opts = Array.prototype.slice.call(select.options);
    var low = String(value).toLowerCase();
    var hit = null;
    for (var i = 0; i < opts.length; i++) {
      var v = String(opts[i].value || '').toLowerCase();
      var t = String(opts[i].textContent || '').trim().toLowerCase();
      if (v === low) { hit = opts[i]; break; }
      if (!hit && t && (t === low || t.indexOf(low) === 0)) hit = opts[i];
    }
    if (hit) { setNative(select, hit.value); return select.value === hit.value; }
    return false;
  }

  function q(sel) { return document.querySelector(sel); }
  function findUser() { return q('#signup-username') || q('input[name="signupUsername"]') || q('input[autocomplete="username"]'); }
  function findPass() { return q('#signup-v2-password') || q('#signup-password') || q('input[autocomplete="new-password"]') || q('input[id*="signup"][type="password"]'); }

  // Birthday selects are identified by their option values, not document
  // order, so extra selects (language pickers) can never be misfilled.
  function findSelects() {
    var out = { month: null, day: null, year: null };
    var sels = Array.prototype.slice.call(document.querySelectorAll('select'));
    for (var i = 0; i < sels.length; i++) {
      var s = sels[i];
      var opts = Array.prototype.map.call(s.options, function(o) { return String(o.value || ''); });
      var has = function(v) { return opts.indexOf(v) >= 0; };
      if (has('Jan') || has('January')) out.month = s;
      else if (has('01') && has('15') && has('31')) out.day = s;
      else if (opts.some(function(v) { return /^\d{4}$/.test(v); })) out.year = s;
    }
    return out;
  }

  function findButton(re) {
    var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < btns.length; i++) {
      if (re.test(String(btns[i].textContent || '').trim())) return btns[i];
    }
    return null;
  }

  // Roblox A/B tests the signup page: one variant is a two-step wizard
  // (Continue -> Add password), another is a classic single-step form with a
  // "Sign Up" button. Any of these, once enabled, advances toward the
  // captcha; the driver clicks whichever appears.
  var ADV_RE = /^(sign up|sign up now|continue|next|add password|register|create account)$/i;
  function advanceButtons() {
    var out = [];
    var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < btns.length; i++) {
      if (ADV_RE.test(String(btns[i].textContent || '').trim())) out.push(btns[i]);
    }
    return out;
  }

  function captchaVisible() {
    return !!document.querySelector('iframe[title*="verification" i], iframe[src*="arkose" i], iframe[src*="funcaptcha" i], iframe[id*="arkose" i], iframe[id*="enforcement" i]');
  }

  // Gender: toggle buttons ("Male" with aria-pressed) in one variant; radio
  // inputs in older layouts. Word-boundary match so "male" never matches
  // "female".
  function clickGender() {
    if (vals.g !== 'Male' && vals.g !== 'Female') return false;
    var btn = findButton(new RegExp('^' + vals.g + '$', 'i'));
    if (btn) {
      var on = btn.getAttribute('aria-pressed') === 'true' || String(btn.className).indexOf('selected') >= 0;
      if (!on && !dbg.take) { try { btn.click(); } catch (e) {} }
      return on;
    }
    var radios = Array.prototype.slice.call(document.querySelectorAll('input[type=radio]'));
    var reG = new RegExp('\\b' + vals.g + '\\b', 'i');
    for (var i = 0; i < radios.length; i++) {
      var r = radios[i];
      var direct = [r.value, r.id, r.name, r.getAttribute('aria-label') || ''].join(' ');
      if (reG.test(direct) || (r.parentElement && reG.test(r.parentElement.textContent || ''))) {
        if (r.checked) return true;
        if (!dbg.take) { try { r.click(); } catch (e) {} }
        return r.checked;
      }
    }
    return false;
  }

  var allFilledAt = 0, lastAdvanceAttempt = 0;
  var h = null, mo = null;

  function stop(reason) {
    if (dbg.stopped) return;
    dbg.stopped = true;
    if (h) clearInterval(h);
    if (mo) mo.disconnect();
    try { console.log('[fleet-prefill] stopped: ' + reason); } catch (e) {}
  }

  function tick() {
    if (dbg.stopped) return;
    dbg.ticks++;
    if (dbg.ticks > 320) { stop('lifetime'); return; }
    if (!onSignupPage()) return;

    var u = findUser(), ps = findPass(), sels = findSelects();
    var passPresent = !!ps;

    if (u && !owned.has(u)) {
      if (u.value !== vals.u) setNative(u, vals.u);
      dbg.filled.u = (u.value === vals.u);
    }
    if (ps && !owned.has(ps)) {
      if (ps.value !== vals.p) setNative(ps, vals.p);
      dbg.filled.p = (ps.value === vals.p);
    }
    if (sels.month && !owned.has(sels.month)) { if (sels.month.value !== vals.m) setSelect(sels.month, vals.m); dbg.filled.m = (sels.month.value === vals.m); }
    if (sels.day && !owned.has(sels.day)) { if (sels.day.value !== vals.d) setSelect(sels.day, vals.d); dbg.filled.d = (sels.day.value === vals.d); }
    if (sels.year && !owned.has(sels.year)) { if (sels.year.value !== vals.y) setSelect(sels.year, vals.y); dbg.filled.y = (sels.year.value === vals.y); }
    dbg.filled.g = clickGender();

    if (dbg.filled.u && dbg.filled.m && dbg.filled.d && dbg.filled.y && (!passPresent || dbg.filled.p) && !allFilledAt) {
      allFilledAt = Date.now();
    }

    // Once the captcha shows, the user is driving: no more automatic step-1
    // clicks, but the driver keeps filling (some flows ask for the password
    // only after the captcha) and may finish one final password step.
    if (captchaVisible() && !dbg.captchaSeen) {
      dbg.captchaSeen = true;
      try { console.log('[fleet-prefill] captcha reached - user takes it from here'); } catch (e) {}
    }

    // Auto-advance: one click when everything is filled and the user has not
    // taken over. A single retry covers a click swallowed mid-transition;
    // after the captcha exactly one more click finishes a trailing password
    // step. After that the form stays in the user's hands.
    var clickBudget = dbg.captchaSeen ? 3 : 2;
    if (allFilledAt && !dbg.take && dbg.clickedAdvance < clickBudget
        && Date.now() - allFilledAt > 1200 && Date.now() - lastAdvanceAttempt > 6000) {
      if (dbg.captchaSeen && (!passPresent || !dbg.filled.p)) return;
      var btns = advanceButtons();
      var target = null, other = null;
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var t2 = String(b.textContent || '').trim();
        if (/^add password$/i.test(t2)) { target = b; break; }
        if (!other && !b.disabled && b.getAttribute('aria-disabled') !== 'true') other = b;
      }
      if (!target) target = other;
      if (target && !target.disabled && target.getAttribute('aria-disabled') !== 'true') {
        dbg.clickedAdvance++; lastAdvanceAttempt = Date.now();
        try { console.log('[fleet-prefill] clicking: ' + String(target.textContent || '').trim()); } catch (e) {}
        try { target.click(); } catch (e) {}
      }
    }
  }

  h = setInterval(tick, 600);
  tick();

  var moQueued = false;
  function startObserver() {
    if (mo || !document.body) return;
    mo = new MutationObserver(function() {
      if (moQueued) return;
      moQueued = true;
      setTimeout(function() { moQueued = false; tick(); }, 200);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) startObserver();
  else {
    var bh = setInterval(function() {
      if (document.body) { clearInterval(bh); startObserver(); }
    }, 300);
  }
})();"#;

fn valid_signup_username(name: &str) -> bool {
    (SIGNUP_USERNAME_MIN..=SIGNUP_USERNAME_MAX).contains(&name.chars().count())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Roblox passwords: 8-20 chars with at least one letter and one digit.
fn valid_signup_password(pass: &str) -> bool {
    (SIGNUP_PASSWORD_MIN..=SIGNUP_PASSWORD_MAX).contains(&pass.chars().count())
        && pass.chars().any(|c| c.is_ascii_alphabetic())
        && pass.chars().any(|c| c.is_ascii_digit())
}

/// Parse "YYYY-MM-DD" into (year, month, day) with real range checks.
fn parse_birthday(raw: &str) -> Option<(i32, u32, u32)> {
    let parts: Vec<&str> = raw.split('-').collect();
    if parts.len() != 3 { return None; }
    let year: i32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || year < 1900 { return None; }
    // Reject impossible dates (Feb 30 etc.).
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 { 29 } else { 28 },
        _ => 0,
    };
    if day > days_in_month { return None; }
    Some((year, month, day))
}

#[tauri::command]
async fn accounts_create(
    app: AppHandle,
    username: Option<String>,
    password: Option<String>,
    birthday: Option<String>,
    gender: Option<String>,
) -> Result<Value, String> {
    let username = username.unwrap_or_default();
    let password = password.unwrap_or_default();
    let birthday = birthday.unwrap_or_default();
    let gender = gender.unwrap_or_default();

    if !valid_signup_username(&username) {
        return Ok(json!({ "ok": false, "error": "The username must be 3-20 characters — letters, numbers and underscores only." }));
    }
    if !valid_signup_password(&password) {
        return Ok(json!({ "ok": false, "error": "The password must be 8-20 characters and include a letter and a number." }));
    }
    let Some((year, month, day)) = parse_birthday(&birthday) else {
        return Ok(json!({ "ok": false, "error": "Pick a valid birthday (YYYY-MM-DD)." }));
    };
    if !matches!(gender.as_str(), "Male" | "Female" | "Skip") {
        return Ok(json!({ "ok": false, "error": "Choose Male, Female or Skip for the profile field." }));
    }

    let label = format!("roblox-signup-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let url = match Url::parse(ROBLOX_SIGNUP_URL) {
        Ok(url) => url,
        Err(err) => return Ok(json!({ "ok": false, "error": err.to_string() })),
    };
    let cookie_url = match Url::parse(ROBLOX_COOKIE_URL) {
        Ok(url) => url,
        Err(err) => return Ok(json!({ "ok": false, "error": err.to_string() })),
    };

    // Values are spliced into PREFILL_SCRIPT as one JSON object — see the
    // const's doc comment above. The script is injected twice (an
    // initialization script that runs at document start on every load, plus
    // an on-page-load eval as backup); both are idempotent via a window
    // guard, so double injection is harmless.
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let vals = json!({
        "u": username,
        "p": password,
        "m": MONTHS[(month - 1) as usize],
        "d": format!("{:02}", day),
        "y": year.to_string(),
        "g": gender,
    });
    let fill_script = PREFILL_SCRIPT.replace("__FLEET_VALS__", &vals.to_string());

    let data_dir = std::env::temp_dir().join(&label);
    let window = match WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title("Create a Roblox account")
        .inner_size(520.0, 760.0)
        .min_inner_size(460.0, 600.0)
        .center()
        .focused(true)
        .user_agent(LOGIN_UA)
        .data_directory(data_dir.clone())
        .initialization_script(fill_script.clone())
        .on_page_load(move |webview, payload| {
            if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                let _ = webview.eval(&fill_script);
            }
        })
        .build()
    {
        Ok(window) => window,
        Err(err) => {
            return Ok(json!({ "ok": false, "error": format!("Could not open the Roblox signup window: {err}") }));
        }
    };

    let started = Instant::now();
    let timeout = Duration::from_secs(10 * 60);
    let cookie = loop {
        if started.elapsed() > timeout {
            let _ = window.close();
            return Ok(json!({ "ok": false, "canceled": true, "error": "Roblox sign-up timed out." }));
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
            launch_auto_fill,
            keeper_arm,
            keeper_disarm,
            keeper_disarm_all,
            keeper_status,
            accounts_list,
            signup_check_username,
            signup_suggest_usernames,
            accounts_add,
            accounts_create,
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
