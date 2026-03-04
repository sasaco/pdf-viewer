# PDF Viewer: PDF.js → Rust PDFium 移行計画 (実施完了報告)

## ✅ ステータス: 完了・バグ修正・機能追加済み (2026-03-04)

計画されていたすべてのフェーズが完了し、追加バグ修正と新機能の実装を経て、高パフォーマンスな Rust/PDFium ベースのレンダリングエンジンが安定稼働しています。

---

## 🐛 バグ修正ログ (2026-03-04 追加)

### Bug 1 【最重要】`rawRgbaData.byteLength` 修正 — `src/app.js`

`invoke()` が返す Tauri IPC `Response` は `ArrayBuffer` オブジェクト。`ArrayBuffer` に `.length` は存在しないため `undefined` になり、Canvas の高さが計算できず真っ黒になっていた。

```diff
- const height = Math.floor(rawRgbaData.length / 4 / width);
+ const byteLen = rawRgbaData.byteLength ?? rawRgbaData.length;
+ const height = Math.floor(byteLen / 4 / width);
```

### Bug 2 【重要】ナビゲーション関数の `state.pdf` 依存除去 — `src/app.js`

`goToPage` / `updateNavButtons` / `setZoom` が `state.pdf`（PDF.js）の有無をチェックしていたため、PDF.js のロードが失敗するとページ送り自体が無効化されていた。→ `state.totalPages` / `state.filePath` でチェックするよう変更。

### Bug 3 【重要】BGRA → RGBA 変換の追加 — `src-tauri/src/renderer.rs`

PDFium のビットマップ出力は **BGRA** 形式。Canvas `ImageData` は **RGBA** を期待するため、変換なしでは赤と青が入れ替わる。→ `chunks_exact(4)` でループして変換。

### Bug 4 【改善】`pdfium.dll` の検索パスを明示 — `src-tauri/src/renderer.rs`

実行ファイルと同じディレクトリを最初に確認し、なければ PATH からフォールバック検索するよう変更。

---

## ✨ 新機能 (2026-03-04 追加)

### 1. Shift + マウスホイール でページめくり

- `handleWheel` に `Shift` キー判定を追加。
- Shift+ホイール上 → 前ページ、Shift+ホイール下 → 次ページ。
- Ctrl+ホイール（ズーム）は変更なし。

### 2. サムネイルサイドバー

- 既存 TOC パネルをタブ付きサイドバーに改造（「目次」「サムネイル」タブ）。
- 「サムネイル」タブを開くと全ページを Rust/PDFium で順番にレンダリング → 小さい Canvas に縮小表示。
- クリックでそのページへジャンプ。現在ページは紫ハイライトで自動同期。
- 新しい PDF を開くと前回のサムネイル生成を中断（`AbortController` 使用）。

---

## 💡 技術的知見

### 1. Tauri V2 `Response` API による「シリアライズ・ゼロ」通信
`tauri::ipc::Response` を使い `Vec<u8>` (Raw RGBA) を JSON エンコードせずバイナリ直接転送。JS 側ではこれが **`ArrayBuffer`** として届くため `.byteLength` を参照すること。

### 2. LIFO (Last-In-First-Out) キューの劇的効果
高速スクロール時、「通り過ぎたページ」のレンダリングを待たず、常に「現在表示されている最新のページ」を最優先処理。体感ラグがほぼゼロになる。

### 3. ハイブリッド・アーキテクチャの妥当性
描画（重い処理）は Rust/PDFium、目次・テキストレイヤー（複雑だが一度限り）は PDF.js という分担が最適。**PDF.js のロード失敗は描画・ナビゲーションに影響しない**よう設計すること（Bug 2 の教訓）。

---

## 🛠️ 他の作業者への Tips

- **PDFium バイナリの配置**: `pdfium.dll` は **実行ファイルと同じディレクトリ** に置くのが最も安全（システム PATH でもOK）。
- **ページインデックス**: PDFium のページインデックスは **0-based**。フロントエンド（1-based）との変換に注意。
- **ビットマップ形式**: `render_with_config` の出力は **BGRA**。Canvas に渡す前に必ず RGBA へ変換すること。
- **レンダリング幅**: `PdfRenderConfig::set_target_width(800)` で固定しているため、JS 側でも `width = 800` で計算する。高 DPI 対応時は `devicePixelRatio` をバックエンドへ渡すよう拡張すること。

---

## 📈 進捗チェックリスト

- [x] ✅ Step 1: 依存関係の整理 (`pdfium-render`, `tokio` の追加)
- [x] ✅ Step 2: バックエンド LIFO キューとワーカースレッドの実装
- [x] ✅ Step 3: `request_render` / `cancel_render` IPC コマンドの実装
- [x] ✅ Step 4: フロントエンド `app.js` の完全刷新 (Canvas 直接描画)
- [x] ✅ Step 5: バックエンド単体テストによる LIFO ロジックの検証
- [x] ✅ Step 6: プロジェクトドキュメント (README.md) の更新
- [x] ✅ Step 7: バグ修正 (byteLength / state.pdf 依存 / BGRA→RGBA / dll パス)
- [x] ✅ Step 8: 新機能追加 (Shift+ホイールでページめくり / サムネイルサイドバー)

---

## 🚀 今後の展望

- **ズームへの動的対応**: ズームレベルに応じてバックエンドでのレンダリング解像度を動的に変更する。
- **ページキャッシュ**: 本格的なページキャッシュ機構を導入し、閲覧済みページへの戻りを更に高速化する。
- **PDFium のコンパイル時リンク**: 現在の動的リンクから静的リンクへ移行し、配布時の依存ファイルを減らす。
- **サムネイル解像度最適化**: サムネイル専用の低解像度レンダリングコマンドを Rust 側に実装し、速度を改善する。
