use tokio::sync::oneshot;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::{State, ipc::Response};
use pdfium_render::prelude::*;

pub struct RenderRequest {
    pub req_id: String,
    pub page_num: usize,
    pub responder: oneshot::Sender<Vec<u8>>,
}

pub struct RenderState {
    pub queue: Mutex<VecDeque<RenderRequest>>,
}

impl RenderState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
        })
    }

    pub fn push_request(&self, req: RenderRequest) {
        let mut queue = self.queue.lock().unwrap();
        queue.push_back(req);
    }

    pub fn pop_request(&self) -> Option<RenderRequest> {
        let mut queue = self.queue.lock().unwrap();
        queue.pop_back() // LIFO
    }

    pub fn cancel_request(&self, req_id: &str) {
        let mut queue = self.queue.lock().unwrap();
        queue.retain(|req| req.req_id != req_id);
    }
}

pub fn start_worker(state: Arc<RenderState>, pdf_path: String) {
    std::thread::spawn(move || {
        let pdfium = Pdfium::new(Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name()).unwrap());
        let document = pdfium.load_pdf_from_file(&pdf_path, None).unwrap();

        loop {
            let request = {
                let mut queue = state.queue.lock().unwrap();
                queue.pop_back() // LIFO
            };

            if let Some(req) = request {
                let pages = document.pages();
                if let Ok(page) = pages.get(req.page_num as u16) {
                    let render_config = PdfRenderConfig::new()
                        .set_target_width(800) // Default width, can be customized
                        .rotate_if_landscape(true);
                    
                    if let Ok(bitmap) = page.render_with_config(&render_config) {
                        let rgba = bitmap.as_rgba8();
                        let _ = req.responder.send(rgba);
                    }
                }
            } else {
                // Sleep briefly if no tasks
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    });
}

#[tauri::command]
pub async fn request_render(
    req_id: String,
    page_num: usize,
    state: State<'_, Arc<RenderState>>,
) -> Result<Response, String> {
    let (tx, rx) = oneshot::channel();
    
    state.push_request(RenderRequest {
        req_id,
        page_num,
        responder: tx,
    });

    match rx.await {
        Ok(data) => Ok(Response::new(data)),
        Err(_) => Err("Render cancelled or failed".to_string()),
    }
}

#[tauri::command]
pub fn cancel_render(req_id: String, state: State<'_, Arc<RenderState>>) {
    state.cancel_request(&req_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lifo_queue() {
        let state = RenderState::new();
        let (tx1, _rx1) = oneshot::channel();
        let (tx2, _rx2) = oneshot::channel();

        state.push_request(RenderRequest {
            req_id: "1".into(),
            page_num: 1,
            responder: tx1,
        });
        state.push_request(RenderRequest {
            req_id: "2".into(),
            page_num: 2,
            responder: tx2,
        });

        let first_pop = state.pop_request().unwrap();
        assert_eq!(first_pop.req_id, "2"); // Should be LIFO

        let second_pop = state.pop_request().unwrap();
        assert_eq!(second_pop.req_id, "1");
    }

    #[test]
    fn test_worker_processing_flow() {
        // This test simulates the worker's loop without actual PDFium calls 
        // to verify the channel and state synchronization.
        let state = RenderState::new();
        let (tx, rx) = oneshot::channel();
        
        state.push_request(RenderRequest {
            req_id: "test".into(),
            page_num: 0,
            responder: tx,
        });

        // Simulate worker popping and sending response
        let req = state.pop_request().unwrap();
        let _ = req.responder.send(vec![1, 2, 3, 4]); // Mock RGBA

        let result = rx.blocking_recv().unwrap();
        assert_eq!(result, vec![1, 2, 3, 4]);
    }
}

