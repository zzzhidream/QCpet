#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--no-proxy-server");
    qcpet_lib::run()
}
