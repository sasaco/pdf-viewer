use tokio::sync::oneshot;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Condvar};
use tauri::{State, ipc::Response};
use pdfium_render::prelude::*;

pub enum Task {
    Load(String, oneshot::Sender<Result<usize, String>>),
    Render(RenderRequest),
}

pub struct RenderRequest {
    pub req_id: String,
    pub page_num: usize,
    pub width: u32,
    pub responder: oneshot::Sender<Vec<u8>>,
}

pub struct RenderState {
    pub queue: Mutex<VecDeque<Task>>,
    pub condvar: Condvar,
}

impl RenderState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
            condvar: Condvar::new(),
        })
    }

    pub fn push_task(&self, task: Task) {
        let mut queue = self.queue.lock().unwrap();
        // LIFO logic: Render requests at the back (taken by pop_back)
        // Load requests could be at the front or back, but let's just push_back for now
        queue.push_back(task);
        self.condvar.notify_one();
    }

    pub fn pop_task(&self) -> Task {
        let mut queue = self.queue.lock().unwrap();
        while queue.is_empty() {
            queue = self.condvar.wait(queue).unwrap();
        }
        queue.pop_back().unwrap() // LIFO
    }

    pub fn cancel_render(&self, req_id: &str) {
        let mut queue = self.queue.lock().unwrap();
        queue.retain(|task| {
            if let Task::Render(req) = task {
                req.req_id != req_id
            } else {
                true
            }
        });
    }
}

pub fn start_worker(state: Arc<RenderState>) {
    std::thread::spawn(move || {
        // 実行ファイルと同じディレクトリから pdfium.dll を検索（最優先）
        // 見つからない場合はシステムの PATH から検索
        let lib_name_os = Pdfium::pdfium_platform_library_name();
        let lib_name_str = lib_name_os.to_string_lossy().to_string();
        let pdfium_result = std::env::current_exe()
            .ok()
            .and_then(|exe| {
                let dir = exe.parent()?;
                let paths = [
                    dir.join(&lib_name_os),
                    dir.join("resources").join(&lib_name_os),
                    dir.join("_up_").join(&lib_name_os),
                ];
                paths.into_iter().find(|p| p.exists())
            })
            .and_then(|path| Pdfium::bind_to_library(&path).ok())
            .or_else(|| Pdfium::bind_to_library(&lib_name_os).ok())
            .map(|lib| Pdfium::new(lib));

        let pdfium = match pdfium_result {
            Some(p) => p,
            None => {
                let err_msg = format!(
                    "PDFium library ({}) not found. Ensure pdfium.dll is in the same directory as the executable or in PATH.",
                    lib_name_str
                );
                eprintln!("{}", err_msg);
                loop {
                    let task = state.pop_task();
                    match task {
                        Task::Load(_, responder) => {
                            let _ = responder.send(Err(err_msg.clone()));
                        }
                        Task::Render(_) => {} // ロード失敗時はレンダリング要求を無視
                    }
                }
            }
        };

        let mut current_document: Option<PdfDocument> = None;

        loop {
            let task = state.pop_task();

            match task {
                Task::Load(path, responder) => {
                    match pdfium.load_pdf_from_file(&path, None) {
                        Ok(doc) => {
                            let page_count = doc.pages().len() as usize;
                            current_document = Some(doc);
                            let _ = responder.send(Ok(page_count));
                        }
                        Err(e) => {
                            let _ = responder.send(Err(format!("PDF load failed: {}", e)));
                        }
                    }
                }
                Task::Render(req) => {
                    if let Some(ref doc) = current_document {
                        let pages = doc.pages();
                        if let Ok(page) = pages.get(req.page_num as u16) {
                            let render_config = PdfRenderConfig::new().set_target_width(req.width as i32);
                            if let Ok(bitmap) = page.render_with_config(&render_config) {
                                // PDFium は BGRA 形式でレンダリングするため RGBA に変換
                                // Canvas の ImageData は RGBA を期待している
                                let raw = bitmap.as_raw_bytes();
                                let mut rgba = Vec::with_capacity(raw.len());
                                for chunk in raw.chunks_exact(4) {
                                    rgba.push(chunk[2]); // R (BGRA の B→G→R→A なので chunk[2]=R)
                                    rgba.push(chunk[1]); // G
                                    rgba.push(chunk[0]); // B
                                    rgba.push(chunk[3]); // A
                                }
                                let _ = req.responder.send(rgba);
                            }
                        }
                    }
                }
            }
        }
    });
}


#[tauri::command]
pub async fn load_pdf(
    path: String,
    state: State<'_, Arc<RenderState>>,
) -> Result<usize, String> {
    let (tx, rx) = oneshot::channel();
    state.push_task(Task::Load(path, tx));

    match rx.await {
        Ok(res) => res,
        Err(_) => Err("Worker thread died".to_string()),
    }
}

#[tauri::command]
pub async fn request_render(
    req_id: String,
    page_num: usize,
    width: u32,
    state: State<'_, Arc<RenderState>>,
) -> Result<Response, String> {
    let (tx, rx) = oneshot::channel();
    
    state.push_task(Task::Render(RenderRequest {
        req_id,
        page_num,
        width,
        responder: tx,
    }));

    match rx.await {
        Ok(data) => Ok(Response::new(data)),
        Err(_) => Err("Render cancelled or failed".to_string()),
    }
}

#[tauri::command]
pub fn cancel_render(req_id: String, state: State<'_, Arc<RenderState>>) {
    state.cancel_render(&req_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lifo_queue() {
        let state = RenderState::new();
        let (tx1, _rx1) = oneshot::channel();
        let (tx2, _rx2) = oneshot::channel();

        state.push_task(Task::Render(RenderRequest {
            req_id: "1".into(),
            page_num: 1,
            width: 800,
            responder: tx1,
        }));
        state.push_task(Task::Render(RenderRequest {
            req_id: "2".into(),
            page_num: 2,
            width: 800,
            responder: tx2,
        }));

        // Should be LIFO, so "2" comes first
        if let Task::Render(first_pop) = state.pop_task() {
            assert_eq!(first_pop.req_id, "2");
        } else {
            panic!("Expected Render task");
        }

        if let Task::Render(second_pop) = state.pop_task() {
            assert_eq!(second_pop.req_id, "1");
        } else {
            panic!("Expected Render task");
        }
    }

    #[test]
    fn test_cancel_render() {
        let state = RenderState::new();
        let (tx1, _rx1) = oneshot::channel();
        let (tx2, _rx2) = oneshot::channel();

        state.push_task(Task::Render(RenderRequest {
            req_id: "1".into(),
            page_num: 1,
            width: 800,
            responder: tx1,
        }));
        state.push_task(Task::Render(RenderRequest {
            req_id: "2".into(),
            page_num: 2,
            width: 800,
            responder: tx2,
        }));

        state.cancel_render("2");

        if let Task::Render(res) = state.pop_task() {
            assert_eq!(res.req_id, "1");
        } else {
            panic!("Expected Render task");
        }
    }

    #[test]
    fn test_load_and_render_flow() {
        let state = RenderState::new();
        let (tx_load, rx_load) = oneshot::channel();
        let (tx_render, rx_render) = oneshot::channel();

        // Push Load task
        state.push_task(Task::Load("dummy.pdf".into(), tx_load));
        
        // Push Render task
        state.push_task(Task::Render(RenderRequest {
            req_id: "r1".into(),
            page_num: 0,
            width: 800,
            responder: tx_render,
        }));

        // Worker side processing
        let task1 = state.pop_task(); // Should be Render (LIFO)
        if let Task::Render(req) = task1 {
            let _ = req.responder.send(vec![255; 4]);
        } else {
            panic!("Expected Render task due to LIFO");
        }

        let task2 = state.pop_task(); // Should be Load
        if let Task::Load(_, res) = task2 {
            let _ = res.send(Ok(10));
        } else {
            panic!("Expected Load task");
        }

        // Verify results
        assert_eq!(rx_render.blocking_recv().unwrap(), vec![255; 4]);
        assert_eq!(rx_load.blocking_recv().unwrap(), Ok(10));
    }

    #[test]
    fn test_worker_init_failure_reporting() {
        let state = RenderState::new();
        let (tx, rx) = oneshot::channel();

        // Simulate the error reporting loop in start_worker when init fails
        let err_msg = "Mock PDFium Init Failure".to_string();
        
        // Push a load task
        state.push_task(Task::Load("test.pdf".into(), tx));

        // Simulate the part of the worker that handles errors
        let task = state.pop_task();
        if let Task::Load(_, responder) = task {
            let _ = responder.send(Err(err_msg.clone()));
        }

        // Verify the responder received the error
        let result = rx.blocking_recv().unwrap();
        assert_eq!(result, Err(err_msg));
    }
}

