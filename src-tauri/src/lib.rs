mod worker;

use tauri::{Manager, RunEvent};
use worker::WorkerSupervisor;

#[tauri::command]
fn worker_endpoint(sup: tauri::State<'_, WorkerSupervisor>) -> Result<Option<worker::Endpoint>, String> {
    sup.endpoint()
}

pub fn run() {
    let app = tauri::Builder::default()
        // A second launch focuses the running window instead of starting a second collector.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![worker_endpoint])
        .setup(|app| {
            let sup = WorkerSupervisor::new(worker::locate_sidecar(app.handle()));
            sup.start();
            app.manage(sup);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(sup) = handle.try_state::<WorkerSupervisor>() {
                sup.shutdown();
            }
        }
    });
}
