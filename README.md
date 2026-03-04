# PDF Viewer (High Performance Edition)

Tauri v2 と Rust + PDFium を使用して構築された、極めて高速で応答性の高いデスクトップ向け PDF ビューアアプリケーションです。

## プラットフォームのハイライト

従来の PDF.js のみのレンダリングから、**Rust エンジン (PDFium) によるネイティブレンダリング**へと刷新されました。

- **極限のレンダリング速度**: C++ ベースの PDFium エンジンと Rust の並列処理能力を活用。
- **LIFO タスクキュー**: 最新スクロール位置を最優先でレンダリングする Last-In-First-Out キューを搭載。
- **シリアライズ・ゼロ通信**: Tauri の `Response` API により Raw RGBA データを JSON 化せず直接転送。
- **確実な中断機構**: 不要なレンダリングタスクを即座にキューから破棄してリソースを節約。
- **BGRA→RGBA 変換**: PDFium の BGRA 出力を Canvas 向け RGBA に正しく変換。

## 技術スタック

| 層 | 技術 |
|---|---|
| フロントエンド | HTML / Vanilla CSS / Vanilla JS + Vite |
| バックエンド (描画) | Rust (Tauri v2) + `pdfium-render` |
| メタデータ処理 | PDF.js (目次・テキストレイヤーのみ) |
| 通信 | Tauri IPC `invoke` — 非圧縮バイナリ (`ArrayBuffer`) 転送 |

---

## 主な機能

### ページ表示・ナビゲーション
- **ネイティブ PDF レンダリング**: PDFium による高速・高品質なネイティブ描画。
- **ダイレクト Canvas 描画**: Raw ピクセルデータを直接 Canvas へ転送。
- **高速ページめくり**: LIFO キューにより「今見ているページ」が常に最優先で描画。
- **動的ズームレンダリング**: ズームレベルに応じてバックエンドで最適な解像度で再レンダリングし、拡大時も鮮明な画像を提供。

### キーボード・マウス操作

| 操作 | 機能 |
|---|---|
| `←` / `PageUp` | 前のページ |
| `→` / `PageDown` | 次のページ |
| `Shift` + ホイール | ページめくり（上: 前へ / 下: 次へ） |
| `Ctrl/Cmd` + ホイール | ズームイン/アウト（解像度追従） |
| `Ctrl/Cmd` + `+` / `-` | ズームイン/アウト |
| `Ctrl/Cmd` + `0` | 100% にリセット |
| `Ctrl/Cmd` + `O` | ファイルを開く |
| `Ctrl/Cmd` + `F` | テキスト検索 |
| `Home` / `End` | 最初/最後のページへ |

### サイドバー（目次 / サムネイル）
- **目次タブ**: PDF の目次（ブックマーク）を階層表示。クリックでジャンプ。
- **サムネイルタブ**: 全ページのサムネイルを Rust/PDFium でレンダリング表示。
  - **描画最適化**: サムネイル専用の解像度（200px）で直接レンダリング・転送することで、メモリと CPU 負荷を最小限に抑制。
  - クリックでジャンプ。現在ページを自動ハイライト。

### その他
- **テキスト検索**: テキストレイヤーのハイライト検索。
- **ダブルクリックで開く**: OS ファイルの関連付けによる直接起動対応。
- **ドラッグ&ドロップ対応**。

---

## ディレクトリ構造

```text
PyMuPDF/
├── src/                        # フロントエンドのソースコード
│   ├── index.html              # UI の骨組み（タブ付きサイドバー含む）
│   ├── app.js                  # Rust レンダラーとの通信・UI ロジック
│   └── style.css               # ダークモード対応デザイン
├── src-tauri/                  # Tauri (Rust) バックエンド
│   ├── src/
│   │   ├── main.rs             # エントリポイント
│   │   ├── lib.rs              # コマンド登録・起動引数処理
│   │   └── renderer.rs         # PDFium レンダラー / LIFO キュー / ワーカースレッド
│   ├── pdfium.dll              # PDFium バイナリ (Windows)
│   └── Cargo.toml              # Rust 依存関係 (pdfium-render, tokio 等)
├── tests/                      # テストスイート
│   ├── pdfium-renderer.test.js # フロントエンド通信テスト
│   └── pdf-viewer.test.js      # ユーティリティテスト
```

---

## 開発と実行

### 必要な環境

- [Node.js](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/)
- PDFium バイナリ (`pdfium.dll`) — 実行ファイルと同じディレクトリに配置

### 起動手順

```powershell
# 1. 依存インストール
npm install

# 2. 開発モードで起動
npm run tauri dev
```

### テスト

```powershell
# バックエンド (Rust) — LIFO キューとキャンセルロジックの検証
cd src-tauri
cargo test

# フロントエンド (Vitest)
npm test
```

---

## 実装上の注意点

| 項目 | 詳細 |
|---|---|
| IPC 戻り値の型 | `invoke()` が返す `Response` は **`ArrayBuffer`**。サイズは `.byteLength` で取得する（`.length` は `undefined`）|
| PDFium のビットマップ形式 | **BGRA** 形式。Canvas `ImageData` に渡す前に **RGBA へ変換**すること |
| ページインデックス | PDFium は **0-based**。フロントエンド（1-based）との変換に注意 |
| 動的レンダリング幅 | フロントエンドの `state.scale` に基づき、`width` パラメータを Rust へ渡して適切な解像度でレンダリングする |
| pdfium.dll の配置 | 実行ファイルと同じディレクトリが最優先。なければ PATH を検索 |

---

## ライセンス

プロジェクトの目的と背景に合わせて設定してください。
