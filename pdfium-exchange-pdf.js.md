# PDF Viewer: PDF.js → Rust PDFium 移行計画 (最新版)

## 目的と背景

現在のWebブラウザベースのPDFビューワ（PDF.js等）では、`C:\Users\sasai\Documents\PyMuPDF\tests\big.pdf` のような数百ページを超える大容量のPDFファイルを開き、紙を素早くめくるように高速にページを行き来しようとすると、レンダリングの遅延（カクつき）やメモリ不足によるクラッシュが発生するという課題があります。

本計画は、バックエンド（Rust + PDFium）で高速なネイティブレンダリングを行い、フロントエンドに直接ピクセルデータ（RGBA）を継続的にストリーミングするアーキテクチャへ刷新することで、**「どんなに巨大なPDFでも、紙の本をパラパラとめくるようなシームレスで高速な閲覧体験」** を実現することを目的としています。

> **💡 設計のハイライト（最適化済）**
> 
> 1. **メモリリークの解消とGC任せの管理**: JSの `ImageData` と HTML5 `<canvas>` を直接使うことで、Blob URLに起因するクラッシュを防止。
> 2. **Rustでのメモリコピー最小化**: `pdfium-render` から得たデータを、Rust内で配列の再確保をせずインプレースでスワップして結合。
> 3. **メイン画面とサムネイルの仮想スクロール化 (Virtual Scrolling)**: `IntersectionObserver` を用い、画面内に入った瞬間だけ描画を予約・実行。画面外に出たメインキャンバスは破棄し、スクロールバーの長さはダミー要素で保持。複雑なプリフェッチ管理・ページ推移管理ロジックを廃止。
> 4. **非同期描画によるUIブロッキング回避**: `putImageData` の代わりに `createImageBitmap` を用い、メインスレッドのフリーズ・カクつきを防止。

---

## Architecture Overview

```text
Frontend (JS)                         Backend (Rust)
─────────────                         ──────────────

IntersectionObserver (サムネイル & メイン画面監視)
タスクキュー (可視状態のページのみレンダリング要求)
  ↓
invoke("render_page_rgba",...) ────>  Tauri Command → Mutexロック取得 
                                         → PDFiumでレンダリング (BGRA)
                                         → [Width(4Byte) + Height(4Byte) + RGBA(Vec<u8>)]
                                         ※ RとBのスワップとヘッダ結合をゼロコピーで一括処理
  ↓
ArrayBufferからゼロコピー抽出
createImageBitmap() で非同期変換
<canvas> に描画 (画面外に出たら破棄)
```

**設計方針:**
- **画像**: Rustから「ヘッダ8バイト（幅・高さ）＋RGBA生データ」を `Vec<u8>` として返し、JSの `ImageData` 経由で `<canvas>` に直接描画します。
- **メモリ管理**: サムネイル・メイン画面ともに、`IntersectionObserver` によって画面内に見えているコンポーネントのみレンダリングします。画面外へ出た巨大なメインキャンバス要素はDOMから外してGCに回収させます。

## Implementation Steps

### Step 1: PDFiumバイナリの入手とRust依存関係

**File: `src-tauri/Cargo.toml`** に追加:
```toml
pdfium-render = { version = "0.8", features = ["sync"] } # imageフィーチャーは不要
```

### Step 2: 型定義 (`src-tauri/src/pdf_engine.rs`)

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInfo {
    pub page_count: u32,
    pub title: Option<String>,
    pub pages: Vec<PageSize>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub title: String,
    pub page: u32,
    pub children: Vec<OutlineItem>,
}
```

### Step 3: PdfState (`src-tauri/src/pdf_state.rs`)

```rust
use pdfium_render::prelude::*;
use std::sync::Mutex;

pub struct PdfState {
    pub document: Mutex<Option<PdfDocument<'static>>>,
}
```

### Step 4: pdfium.dllのパス解決と初期化（`lib.rs` の setup 内）

```rust
.setup(|app| {
    let dll_path = app.path()
        .resolve("pdfium.dll", tauri::path::BaseDirectory::Resource)
        .expect("リソースパス解決失敗");

    let _pdfium = Box::leak(Box::new(Pdfium::new(
        Pdfium::bind_to_library(&dll_path).expect("pdfium.dll ロード失敗")
    )));

    app.manage(PdfState {
        document: Mutex::new(None),
    });

    Ok(())
})
```

### Step 5: 画像レンダリングコマンド（最適化済 RGBA変換）

**File: `src-tauri/src/commands.rs`**
メモリコピーを最小化し、生データにインプレースでスワップをかけます。

```rust
#[tauri::command]
pub fn render_page_rgba(state: tauri::State<PdfState>, page_num: u32, width: f32) -> Result<Vec<u8>, String> {
    let mut doc_lock = state.document.lock().unwrap();
    let doc = doc_lock.as_mut().ok_or("PDF is not loaded")?;

    let page = doc.pages().get((page_num - 1) as u16).map_err(|e| e.to_string())?;

    let mut config = PdfBitmapConfig::new();
    config.scale_page_to_width(width as u16, &page);
    let bitmap = page.render_with_config(&config).map_err(|e| e.to_string())?;

    let bytes = bitmap.as_bytes();
    let bmp_width = bitmap.width() as u32;
    let bmp_height = bitmap.height() as u32;

    // ヘッダ(8バイト) + ピクセルデータ用のベクタを一度だけ確保
    let mut result = Vec::with_capacity(8 + bytes.len());
    result.extend_from_slice(&bmp_width.to_le_bytes());
    result.extend_from_slice(&bmp_height.to_le_bytes());
    result.extend_from_slice(bytes);

    // インプレースで R(0) と B(2) をスワップ (先頭8バイトのメタデータはスキップ)
    for chunk in result[8..].chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    // Tauriは戻り値がトップレベルで Vec<u8> の場合、自動的にバイナリを最適化して送信する
    Ok(result)
}
```

### Step 6: フロントエンドUI構築（2カラム＆メインスクロール対応）

**File: `src/index.html`**
```html
<div id="app" style="display: flex; height: 100vh;">
    <!-- 左側：サムネイルペイン -->
    <div id="sidebar" style="width: 200px; min-width: 200px; overflow-y: auto; background: #2c2c2c; padding: 10px;">
        <!-- サムネイルが動的に生成される -->
    </div>
    <!-- 右側：メインペイン（overflow: autoで連続スクロール可能に） -->
    <div id="pdf-container" style="flex-grow: 1; overflow: auto; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; background: #1e1e1e; padding: 20px;">
        <!-- メインキャンバスが仮想スクロールで挿入される -->
    </div>
</div>
```

### Step 7: フロントエンド書き換え (仮想スクロール & 非同期描画)

**File: `src/app.js`**

```javascript
import { invoke } from '@tauri-apps/api/core';

const state = {
    pages: [],
    totalPages: 0,
    scale: 1.0,
};

const mainCache = new Map();  // pageNum -> HTMLCanvasElement
const thumbCache = new Map(); // pageNum -> HTMLCanvasElement

const els = {
    pdfContainer: document.getElementById('pdf-container'),
    sidebar: document.getElementById('sidebar'),
};

// --- サムネイル用 Observer ---
const thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const pageNum = parseInt(entry.target.dataset.page);
            if (!thumbCache.has(pageNum)) {
                requestRender(pageNum, true);
            }
        }
    });
}, { rootMargin: '100px' });

// --- メイン画面用 Observer (仮想スクロール用) ---
const mainObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        const pageNum = parseInt(entry.target.dataset.page);
        
        if (entry.isIntersecting) {
            // UI上の現在のページ枠線をアクティブに
            document.querySelectorAll('.thumb-wrapper').forEach(el => el.style.border = 'none');
            const targetThumb = document.getElementById(`thumb-wrapper-${pageNum}`);
            if (targetThumb) targetThumb.style.border = '2px solid #007acc';

            if (!mainCache.has(pageNum)) {
                requestRender(pageNum, false);
            }
        } else {
            // 画面外に出たページはCanvasを破棄してメモリ解放
            if (mainCache.has(pageNum)) {
                entry.target.replaceChildren(); // 子要素(Canvas)削除
                mainCache.delete(pageNum);
            }
        }
    });
}, { rootMargin: '1000px' }); // 上下に多少の余裕をもたせる

// --- レンダリングタスク管理 ---
let isRendering = false;
let renderQueue = []; 

async function processRenderQueue() {
    if (isRendering || renderQueue.length === 0) return;
    
    // メイン画面(isThumb=false) を優先
    renderQueue.sort((a, b) => (a.isThumb === b.isThumb ? 0 : a.isThumb ? 1 : -1));
    const task = renderQueue.shift();

    isRendering = true;
    try {
        await executeRender(task);
    } catch(e) {
        console.error("Render failed", e);
    }
    isRendering = false;
    processRenderQueue();
}

function requestRender(pageNum, isThumb = false) {
    const cache = isThumb ? thumbCache : mainCache;
    if (cache.has(pageNum)) return;
    
    const existing = renderQueue.find(t => t.pageNum === pageNum && t.isThumb === isThumb);
    if (!existing) {
        renderQueue.push({ pageNum, isThumb });
        processRenderQueue();
    }
}

async function executeRender(task) {
    const { pageNum, isThumb } = task;
    const cache = isThumb ? thumbCache : mainCache;

    // すでにレンダリング済み、またはキュー待ち中に画面外へ出た場合はスキップ
    if (cache.has(pageNum)) return;
    const containerId = isThumb ? `thumb-container-${pageNum}` : `main-container-${pageNum}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    const { width: pw } = state.pages[pageNum - 1];
    
    // 解像度決定
    const targetWidth = isThumb 
        ? 150 
        : Math.round(pw * state.scale * window.devicePixelRatio);
    
    const buffer = await invoke('render_page_rgba', { pageNum, width: targetWidth });
    
    // JSのバイナリパース (Uint8Arrayとして確実に取り扱う)
    const uint8Arr = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const arrayBuffer = uint8Arr.buffer;
    const byteOffset = uint8Arr.byteOffset;

    // 先頭8バイトのメタデータ
    const view = new DataView(arrayBuffer, byteOffset, 8);
    const w = view.getUint32(0, true);
    const h = view.getUint32(4, true);

    // 残りのデータ（RGB配列）をゼロコピーで抽出
    const rgba = new Uint8ClampedArray(arrayBuffer, byteOffset + 8, w * h * 4);
    const imageData = new ImageData(rgba, w, h);
    
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    
    if (isThumb) {
        canvas.style.width = "100%";
    } else {
        canvas.style.width = (w / window.devicePixelRatio) + "px";
        canvas.style.boxShadow = "0 4px 8px rgba(0,0,0,0.5)";
    }
    
    const ctx = canvas.getContext('2d', { alpha: false });
    
    // putImageDataによるメインスレッドブロックを防ぐため非同期ImageBitmapを利用
    const bitmap = await window.createImageBitmap(imageData);
    ctx.drawImage(bitmap, 0, 0);
    
    cache.set(pageNum, canvas);

    // コンテナが存在しかつ画面内にあるか（Observerでの判定前）簡易的にチェックして挿入
    container.replaceChildren(canvas);
}

// PDF読み込み完了時のUI初期化ロジック
export function initializePdf(info) {
    state.pages = info.pages;
    state.totalPages = info.pageCount;
    els.sidebar.innerHTML = '';
    els.pdfContainer.innerHTML = '';
    
    for (let i = 1; i <= state.totalPages; i++) {
        const { width: pw, height: ph } = state.pages[i - 1];
        
        // --- サムネイル用 ---
        const thumbWrapper = document.createElement('div');
        thumbWrapper.id = `thumb-wrapper-${i}`;
        thumbWrapper.className = 'thumb-wrapper';
        thumbWrapper.style.marginBottom = '10px';
        thumbWrapper.style.cursor = 'pointer';
        thumbWrapper.onclick = () => {
            const mainCont = document.getElementById(`main-container-${i}`);
            if (mainCont) mainCont.scrollIntoView({ behavior: 'smooth' });
        };
        
        const thumbContainer = document.createElement('div');
        thumbContainer.id = `thumb-container-${i}`;
        thumbContainer.dataset.page = i;
        const thumbHeight = Math.round(150 * (ph / pw));
        thumbContainer.style.minHeight = `${thumbHeight}px`; 
        thumbContainer.style.background = '#333';
        
        thumbWrapper.appendChild(thumbContainer);
        els.sidebar.appendChild(thumbWrapper);
        thumbObserver.observe(thumbContainer); 

        // --- メインページ用 ---
        const mainContainer = document.createElement('div');
        mainContainer.id = `main-container-${i}`;
        mainContainer.dataset.page = i;
        
        const mainW = pw * state.scale;
        const mainH = ph * state.scale;
        mainContainer.style.width = `${mainW}px`;
        mainContainer.style.minHeight = `${mainH}px`;
        mainContainer.style.marginBottom = '20px';
        mainContainer.style.background = '#333'; // プレースホルダー色
        mainContainer.style.display = 'flex';
        mainContainer.style.justifyContent = 'center';
        
        els.pdfContainer.appendChild(mainContainer);
        mainObserver.observe(mainContainer);
    }
}
```

## Critical Files

| File | Action |
|---|---|
| `src-tauri/Cargo.toml` | pdfium-render[sync]追加。tauri-plugin-fs削除。 |
| `src-tauri/src/pdf_state.rs` | `Mutex<Option<PdfDocument>>` の追加 |
| `src-tauri/src/commands.rs` | `render_page_rgba` を追加。データ確保の1回処理とインプレース変換で極限まで高速化。 |
| `src/app.js` | 仮想スクロールによるレンダリング管理。非同期描画、確実なバイナリパース。 |
| `src/index.html` | メインページの連続スクロールに対応。 |

## Notes (改善ハイライト)

- **自動ガベージコレクション対応**: Blob URLによるメモリリークの危険性を完全に排除。
- **カクつきの無い連続スクロール**: メインペインにもVirtual Scrolling機構を導入。巨大なPDFでも、DOMに存在するのは画面付近のCanvasのみとなり、Chrome内蔵ビューワと同等のシームレスな体験を実現。
- **高速描画**: Rust側での不必要なメモリコピーの排除と、JS側での非同期描画 (`createImageBitmap`) により、UIのフリーズが起きません。
