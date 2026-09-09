// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Self-update restart: the previous version spawned us with
    // --takeover=<its pid> after swapping our files in. Wait for it to exit
    // so two windows never coexist, then sweep the retired files it left.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(pid) = fleet_lib::parse_takeover_pid(&args) {
        fleet_lib::wait_for_process_exit(pid, std::time::Duration::from_secs(20));
    }
    fleet_lib::cleanup_retired_update_files();
    fleet_lib::run();
}
