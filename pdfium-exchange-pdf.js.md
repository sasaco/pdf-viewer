# PDF Viewer: PDF.js → Rust PDFium 移行計画 (最新版 - アーキテクチャ刷新)

## 目的と背景

現在のWebブラウザベースのPDFビューワでのレンダリング遅延やメモリ不足によるクラッシュを解決するため、バックエンド（Rust + PDFium）でのネイティブレンダリングに移行します。

> **💡 設計のハイライト（最新のアーキテクチャ・パフォーマンスレビュー反映済）**
> 
> 以前の「Tempファイル経由での画像配信」や「手動タスクキュー管理」にはディスクI/Oのボトルネックやメモリ枯渇のリスクがありました。これらを解決するためのインメモリ通信案も、不確実性や通信オーバーヘッドの指摘を受けたため、本計画は最終的に**Tauri IPCによるOne-shot待機型通信と、Raw RGBA+Canvasダイレクト描画による極限の最適化アーキテクチャ**へと方針を転換・洗練させています。
>
> 1. **エンコード負荷・シリアライズ負荷の完全排除（Rawバイナリ直接通信＋Canvas）**:
>    BMP変換などの画像処理を行わず、Rust側からPDFiumが出力した**生のピクセルデータ（Raw RGBA）を無加工で**フロント側に返します。この際、Tauri IPCのバイナリ直接応答機能（`Response` API等）を用い、長大なバイト配列がJSONにエンコード・デコードされるオーバーヘッドを完全に回避します。
>    *採用理由*: 本計画の主目的である「エンコード負荷の極小化」を達成し、最高クラスのパフォーマンスを引き出すためには、画像フォーマット変換やJSON文字列化等のあらゆる中間処理を削ぎ落とすことが必須であるためです。
>
> 2. **One-shot待機型のバックエンド非同期アーキテクチャ**:
>    Tauriの `invoke` 実装において、`tokio::sync::oneshot` チャネルをタスクに同梱し、レンダリングが完了するまでRust側のコマンドハンドラで待機（`await`）してフロントへ直接解を返す設計へ変更しました。
>    *採用理由*: 無闇な非同期イベントリスナー（イベントプル型）をフロントエンドに散りばめる複雑さを避け、JS側で `const data = await invoke(...)` と直感的に結果を待機・取得できるようにするためです。フロントの同期的なJS記述構造を維持する上で最も効果の高いアプローチです。
>
> 3. **処理の直列化と排他制御（Mutex）の排除**:
>    単一のワーカースレッドがPDFiumインスタンス（PdfDocument）の所有権を独占し、キューからタスクをLIFOで取り出して処理する設計に変更しました。
>    *採用理由*: バックエンドにワーカーが1つしか存在しないため、複数スレッドからの同時アクセスが物理的に起こらず、`Mutex`等の複雑な排他制御機構を丸ごと排除できます。これにより、ロック取得のオーバーヘッドやデッドロックのリスクが消え、コードも非常にシンプルになります。
>
> 4. **完全な仮想スクロール（Virtual Scrolling）の採用（継続）**:
>    *採用理由*: 数万ページのPDFにおいてDOMリソースを抑え、「上限のないスクロールパフォーマンス」を確保・維持するためです。
>
> 5. **確実な中断機構（キャンセル状態管理の単純化）**:
>    別個のHashSetを用いたキャンセルIDの管理をやめ、「フロントエンドから `cancel_render` 要求が来た時点で、ワーカースレッドの待機キュー(`queue`)自体から該当リクエストを即座に削除（Remove）する」間引き方式を採用しました。
>    *採用理由*: 余分な状態管理を持たないことでメモリリークの懸念を排除し、ロジックをより堅牢・シンプルにするためです。PDFiumにおける「実行中タスク」の中途キャンセル可否が不明である現状において、確実にコントロール可能な「実行前タスクのキュー破棄」に注力することが最も妥当なアプローチです。

---

## Architecture Overview

```text
Frontend (JS/HTML)                                Backend (Rust Tauri)
──────────────────                                ────────────────────

Virtual Scroller (DOMノードリサイクル)
  │
  ├─ [ページの表示要求]
  │   const rawData = await invoke('request_render', { page: 1, req_id: 'A' }) 
  │   │                                                        │ Tauri IPC (Command)
  │   │                                                        ↓
  │   │                                           [LIFOキューへ追加] 
  │   │                                             ※ one-shotチャネル(sender)を同梱
  │   │
  │   │(※ スクロールアウトで不要になった場合)     [単一ワーカースレッド] (Mutex不要でPdfDocumentを独占)
  │   │ invoke('cancel_render', { req_id: 'A' }) ─┼─ キューを検索し、req_id 'A' があれば即座に削除
  │   │                                           │  (間引き処理。別管理のHashSet等は不要)
  │   │                                           │
  │   │                                           ├─ キューから最新タスク(LIFO)を取得
  │   │                                           ├─ 該当ページをレンダリング (Pdfium)
  │   │                                           ├─ Raw RGBA Byte Arrayとして取得
  │   │                                           ├─ one-shotチャネル経由で Command に結果を返却
  │   │                                           │  (Tauriのシリアライズ回避 Response 機能を利用)
  │   <───────────────────────────────────────────┘
  │      Response (Uint8Array / JSON化を経由しない生バイナリ)
  │
  ├─ [Canvas ダイレクト描画]
  │   ctx.putImageData(...)
```

**設計方針:**
- **通信アーキテクチャの最適化と排他制御の排除**: One-shotチャネルを活用した待機型IPC応答により、フロントから安全に同期処理を記述可能とし、バックエンド側は単一スレッドのPDFium独占によってMutexロックの無駄を排除。
- **キャンセル制御の単純・確実化**: 複数の状態変数を管理する複雑さを避け、キューからの実削除一本に間引き処理を絞り、スクロール詰まりを防止。
- **エンコード・シリアライズ負荷の完全なゼロ化**: 非圧縮生データを扱い、かつTauriのシリアライズ回避レスポンスを用いることで、描画に関わるすべての計算コストを物理的に削ぎ落とす。

## Implementation Steps

### Step 1: 依存関係の整理

**File: `src-tauri/Cargo.toml`**
画像フォーマットの変換（BMP等）は行わないため `image` クレートは不要となります。通信および同期基盤の依存のみを追加します。

```toml
[dependencies]
pdfium-render = { version = "0.8", features = ["sync", "thread_safe"] }
tokio = { version = "1.0", features = ["rt-multi-thread", "macros", "sync"] }
```

### Step 2: バックエンドIPCとLIFOキューの実装

**File: `src-tauri/src/main.rs`**
`tokio::sync::oneshot` と Tauriの `Response` (シリアライズ回避機能) を組み合わせて、非同期かつ生のバイナリ転送を実現します。

```rust
use tauri::{State, Manager, ipc::Response};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::oneshot;
use std::collections::VecDeque;
// その他必要なインポート（pdfiumの実装等）

// タスクリクエストの定義
struct RenderRequest {
    req_id: String,
    page_num: usize,
    // レンダリング結果をTauriコマンドハンドラ(フロントへの応答)へ返すためのチャネル
    responder: oneshot::Sender<Vec<u8>>,
}

struct RenderState {
    // 処理待ちキュー (Mutexで保護するがPdfDocumentは保護しない)
    queue: StdMutex<VecDeque<RenderRequest>>,
    // ※ 実際の運用ではスレッド起床用の Condvar や notify 等もここに含める
}

#[tauri::command]
async fn request_render(req_id: String, page_num: usize, state: State<'_, Arc<RenderState>>) -> Result<Response, String> {
    // 戻り値受け取り用のOne-shotチャネルを生成
    let (tx, rx) = oneshot::channel();
    
    {
        let mut queue = state.queue.lock().unwrap();
        // LIFO (最新のリクエストを優先) のため末尾に追加
        queue.push_back(RenderRequest { req_id, page_num, responder: tx });
    }
    
    // ※ キュー追加後にワーカースレッドへ起床シグナルを送る

    // ワーカースレッドからの処理完了(画像データ)を待機
    match rx.await {
        Ok(raw_rgba) => {
            // JSONシリアライズ不可避の問題を回避するため、生バイナリ応答を生成
            // (注: Tauriのバージョンによって生データ返却用のAPIは異なる。これはV2を想定)
            Ok(Response::new(raw_rgba)) 
        },
        Err(_) => Err("Render cancelled".into())
    }
}

#[tauri::command]
fn cancel_render(req_id: String, state: State<'_, Arc<RenderState>>) {
    let mut queue = state.queue.lock().unwrap();
    // 該当するリクエストIDが未処理状態であれば、キューから直接破棄する (HashSet管理の廃止)
    queue.retain(|req| req.req_id != req_id);
}

// ワーカースレッドの擬似コード
/*
tokio::spawn(async move {
    // PdfDocumentインスタンスの所有権はワーカースレッドだけが持つ (Mutex不要)
    // let pdfium_document = ...; 

    loop {
        let task = {
            let mut queue = state.queue.lock().unwrap();
            queue.pop_back() // LIFOで末尾から取得
        };

        if let Some(req) = task {
            // pdfiumを用いたレンダリング処理を実行 (ロックを意識せず直接呼び出せる)
            // let rgba = render_page(&pdfium_document, req.page_num);
            
            // チャネルを通じて `request_render` の `rx.await` に結果を送信
            // let _ = req.responder.send(rgba);
        } else {
            // キューが空の場合は待機
        }
    }
});
*/

fn main() {
    // ... Tauri 初期化コード
}
```

### Step 3: フロントエンドUI構築 (Canvas直接描画)

**File: `src/app.js` などのフロントエンドロジック**
同期的に `await` で結果を受け取り、JSONのオーバーヘッドが取り除かれた `Uint8Array` を受け取って Canvas に転写します。

```javascript
import { invoke } from '@tauri-apps/api/core';

async function renderPageToCanvas(pageNum, canvasElement) {
    const reqId = `req_${pageNum}_${Date.now()}`;
    const ctx = canvasElement.getContext('2d');
    
    let isCancelled = false;
    const cleanup = () => {
        isCancelled = true;
        // バックエンドのキューから直接削除させる
        invoke('cancel_render', { req_id: reqId });
    };

    try {
        // One-shot待機型のバックエンドによる実装により、結果を直接 await 可能。
        // ※ Rawバイナリ応答を用いることで、JSONパースコスト無しの Uint8Array が返却される想定
        const rawRgbaData = await invoke('request_render', { page_num: pageNum, req_id: reqId });
        
        // await を抜けた後に自身がキャンセル状態なら描画を破棄
        if (isCancelled) return;

        // 受け取った生データを用い ImageData を構成
        const width = 800; // 仮の幅
        const height = 1131; // 仮の高さ
        const imageData = new ImageData(
            new Uint8ClampedArray(rawRgbaData),
            width,
            height
        );
        ctx.putImageData(imageData, 0, 0);

    } catch (error) {
        if (!isCancelled) {
            console.error("Render failed or cancelled:", error);
        }
    }

    return cleanup;
}
```

## Critical Files

| File | Action |
|---|---|
| `src-tauri/Cargo.toml` | `image` クレートを削除し、純粋なPDF解析とタスク制御のための依存のみに整理。 |
| `src-tauri/src/main.rs` | Custom Protocolから脱却し、One-shotチャネルとTauriのRaw Responseによる待機型IPC (`invoke`) へ移行。<br>キャンセル管理の削減（HashSetから、キューの直接 `retain` による削除へ変更）、および `PdfDocument` に対する `Mutex` の完全排除（単一スレッドによる独占保有化）。 |
| `src/app.js` | `<canvas>`＋RGBAアレイ直接描画への変更。`await` で通信終了と同時に結果を同期待機できるシンプルで高速な構造を実現し、スクロールアウト時は `cancel_render` で確実にバックエンドに間引きを指示する。 |
