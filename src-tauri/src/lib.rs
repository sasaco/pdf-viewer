mod renderer;
use tauri::{Emitter, Manager};


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let render_state = renderer::RenderState::new();
    // ワーカースレッドの開始 (一回だけ起動)
    renderer::start_worker(render_state.clone());

    tauri::Builder::default()
        .manage(render_state.clone())
        .invoke_handler(tauri::generate_handler![
            renderer::load_pdf,
            renderer::request_render,
            renderer::cancel_render
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // コマンドライン引数から PDF パスを取得し、フロントへ送信
            let args: Vec<String> = std::env::args().collect();
            let pdf_path = args
                .iter()
                .skip(1)
                .find(|a| a.to_lowercase().ends_with(".pdf"))
                .cloned();

            if let Some(path) = pdf_path {
                let window = app.get_webview_window("main").unwrap();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = window.emit("open-pdf", path);
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


