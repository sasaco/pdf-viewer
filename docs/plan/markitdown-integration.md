# MarkItDown 導入計画

## 1. 目的と背景

[microsoft/markitdown](https://github.com/microsoft/markitdown) を本アプリ（Tauri v2 + PDF.js ベースの PDF Viewer）に導入し、表示中の PDF や任意のファイルを **Markdown へ変換** する機能を追加する。

### 想定ユースケース
- 開いている PDF を Markdown に変換してクリップボードへコピー / `.md` で保存
- ドラッグ＆ドロップした DOCX / PPTX / XLSX / HTML / 画像（OCR）などを Markdown 化
- 将来的に LLM 連携（要約・QA）の入力フォーマットとして活用

---

## 2. 前提と制約

| 項目 | 内容 |
|------|------|
| 既存方針 | `README.md` 記載のとおり「Python sidecar を脱却し Tauri + PDF.js のみで完結」。**Python依存の再導入は慎重に判断する必要がある** |
| markitdown の実体 | Python パッケージ (`pip install 'markitdown[all]'`)。CLI / Python API / MCP サーバを提供 |
| 配布形態 | Windows NSIS / MSI インストーラ（追加ランタイム不要が現状の売り） |
| 既存依存 | Tauri 2.10、Rust 1.77+、Node 16+、PDF.js 5.x |

**重要トレードオフ**: markitdown を入れると Python ランタイムが必要になる。これは既存の「追加ランタイム不要」原則に反するため、以下のアーキテクチャ案を比較検討する。

---

## 3. アーキテクチャ案の比較

### 案A: Python Sidecar (PyInstaller で markitdown CLI を凍結)
- Tauri の sidecar 機能で `markitdown.exe`（PyInstaller などで凍結したバイナリ）を同梱。
- **長所**: 公式実装そのもの。全フォーマットを網羅。
- **短所**: バンドルサイズが +50〜150MB。Defender 誤検知リスク。バージョン更新ごとに再凍結が必要。

### 案A': **uv ブートストラップ方式（marimo デスクトップ版と同じ手法、本命）**
- `uv.exe` だけを Tauri リソースとして同梱（~15MB）。
- 初回起動時に Rust 側から `uv python install 3.13` → `uv venv` → `uv pip install markitdown[...]` を順に実行し、ユーザーの `app_data_dir` 配下に隔離環境を構築。
- 2回目以降は venv が存在するためスキップ。markitdown のバージョンが上がったら `uv pip install --upgrade` のみ走らせる。
- **長所**: バンドルサイズ最小（~15MB増）／凍結バイナリ不要／ランタイム更新が容易／Defender 誤検知リスク低／**社内に同手法の実績あり (marimo `src-tauri/src/environment/bootstrap.rs`)**。
- **短所**: 初回起動時に Python ダウンロード（~30MB、回線次第で数十秒〜1分）が必要。オフライン初回起動は不可（要対策: 案A と組み合わせも可）。

### 案B: MCP サーバとして外部起動
- `markitdown-mcp` を別プロセス起動し、Tauri から HTTP/stdio で呼び出す。
- **長所**: アーキテクチャが疎結合。開発時はホストの `pip install` で済む。
- **短所**: 配布時は結局 Python 同梱が必要。MCP の意義は LLM 連携時に発揮されるため、単独利用ではオーバースペック。

### 案C: Rust ネイティブ実装に置き換え
- PDF→Markdown は `pdf-extract` + 自前整形、DOCX は `docx-rs`、XLSX は `calamine` 等。
- **長所**: 追加ランタイム不要を維持。バンドルサイズ最小。
- **短所**: markitdown の対応フォーマット（YouTube/音声/画像 OCR/EPUB 等）を再現する工数が極めて大きい。

### 案D: PDF だけは PDF.js でテキスト抽出 → Markdown 整形（自前）。他フォーマットは案A/Bを後追い
- フェーズ1で PDF のみ JS 側で完結し、フェーズ2以降で markitdown を sidecar 導入。
- **長所**: 主要ユースケースを最小コストで実現。既存原則と矛盾しない。
- **短所**: 機能が段階提供になる。

### 推奨
**案D（PDF のみ純JS）→ 案A'（uv ブートストラップで markitdown 本体を導入）** の二段階。  
案A' は marimo デスクトップ版で実運用されている手法と同じで、PyInstaller 凍結を避けつつ Python 系ツールを Tauri アプリに組み込める。markitdown の `pip install markitdown[all]` を venv に入れるだけで済むため実装コストも最小。

---

## 4. フェーズ別実装計画

### フェーズ1: PDF → Markdown（案D 範囲、Python 不要）
目標: 開いている PDF を Markdown 化してコピー / 保存できる。

1. **抽出ロジック新設** `src/markdown/pdfToMarkdown.js`
   - PDF.js `getTextContent()` を全ページに対して走査。
   - フォントサイズ / Y座標 / `transform` を見て見出し階層（`#`〜`####`）を推定。
   - 連続する同サイズ行は段落として結合、空 Y ギャップで段落区切り。
   - 箇条書き検出（先頭が `•`, `・`, `-`, 数字+`.`）。
   - 表検出（同 Y 上の複数 X クラスタ）→ Markdown table（精度限界あり、ベストエフォート）。
   - リンクアノテーション（`getAnnotations()`）を Markdown リンクに反映。
2. **UI 追加** `src/index.html` / `src/app.js`
   - ツールバーに「Markdown でコピー」「Markdown で保存」ボタン。
   - 保存は `@tauri-apps/plugin-dialog` の `save()` + `plugin-fs` の `writeTextFile`。
3. **テスト** `tests/markdown/pdfToMarkdown.test.js` (vitest)
   - `tests/test2.pdf`, `tests/test3.pdf` を入力にスナップショット比較。
   - 見出し推定 / 段落結合 / リスト検出のユニットテスト。
4. **設定** `src-tauri/capabilities/default.json`
   - `dialog:allow-save`, `fs:allow-write-text-file` の許可スコープ確認。

**完了条件**: 既存テスト PDF 2件で目視確認可能な Markdown が出力され、vitest がグリーン。

### フェーズ2: 多形式対応（案A': uv ブートストラップ方式）
目標: DOCX / PPTX / XLSX / HTML / 画像 / EPUB などをドラッグ＆ドロップで Markdown 化。  
**実装パターンは [`marimo/src-tauri/src/environment/bootstrap.rs`](file:///c:/Users/sasai/Documents/marimo/src-tauri/src/environment/bootstrap.rs) に準拠する。**

#### 2-1. リソースの同梱
- `src-tauri/binaries/uv.exe`（および将来の `uv` for macOS/Linux）を配置。
  - 取得: GitHub Release `astral-sh/uv` から OS/arch ごとに DL → `binaries/` に配置するスクリプト `src-tauri/fetch-uv.js` を追加（marimo と同じ慣習）。
- `src-tauri/resources/markitdown-deps/pyproject.toml` を新設し、依存を以下のように固定:
  ```toml
  [project]
  name = "pdfviewer-markitdown-env"
  version = "0.0.0"
  requires-python = ">=3.10"
  dependencies = ["markitdown[docx,pptx,xlsx,outlook,xls]==0.0.x"]
  ```
  - `[all]` ではなく必要 extras のみに絞り、サイズと初回 install 時間を抑える。
- `src-tauri/tauri.conf.json` の `bundle.resources` に以下を追加:
  ```json
  "resources": [
    "binaries/uv*",
    "resources/markitdown-deps/pyproject.toml"
  ]
  ```

#### 2-2. パス解決モジュール `src-tauri/src/paths.rs` (新規)
marimo の `paths.rs` をほぼ流用:
- `get_uv_bin(app)` → debug 時はシステム `uv`、release 時は `resource_dir/binaries/uv.exe`。
- `get_env_dir(app)` → `app_data_dir/markitdown-env`。
- `get_python_install_dir(app)` → `app_data_dir/python`。
- `get_venv_python(env_dir)` → Win は `Scripts/python.exe`、Unix は `bin/python`。

#### 2-3. ブートストラップ `src-tauri/src/markitdown/bootstrap.rs` (新規)
marimo の `environment/bootstrap.rs` を**ほぼそのまま流用**:
1. `uv python find ">=3.10"`（`UV_PYTHON_INSTALL_DIR` を指定、`UV_PYTHON_PREFERENCE=only-managed`）。
2. 見つからなければ `uv python install 3.13`。
3. venv 不在 or バージョン不一致なら `uv venv --seed --python <python> <env_dir>`。
4. `uv pip install --python <venv_python> <bundled-pyproject-dir>` で markitdown を venv にインストール。
5. stderr を行ごとに `on_progress` コールバックでフロントへ転送（splash UI に表示）。
6. Windows の `CREATE_NO_WINDOW` (0x08000000) を必ず付与してコンソール窓のフラッシュを防止。

**呼び出し時点**: アプリ起動の `setup()` 内で非同期タスクとして起動し、未完了のうちは「Markdown 化」ボタンを disabled にする。完了通知は Tauri Event (`markitdown://ready` など) で broadcast。

#### 2-4. Tauri コマンド `src-tauri/src/markitdown/commands.rs`
```rust
#[tauri::command]
async fn convert_to_markdown(app: AppHandle, path: String) -> Result<String, String>
```
- venv 内 `python -m markitdown <path>` を実行し stdout を回収（`Command::new(venv_python)`、`CREATE_NO_WINDOW` 付与）。
- 実行前に `is_environment_ready` をチェックし、未完了ならエラーを返す（フロント側で「準備中」表示）。

#### 2-5. capabilities
- `src-tauri/capabilities/default.json` には **`shell:allow-execute` を追加しない**（venv の python は Tauri の resource ではなくユーザーデータ配下にあり、Rust から `std::process::Command` 直接実行で問題なし）。
- 既存 `dialog`/`fs` パーミッションのみで足りる。

#### 2-6. フロント連携 `src/markdown/convert.js`
- 拡張子で分岐: PDF はフェーズ1の純JS実装、それ以外は `invoke('convert_to_markdown', { path })`。
- 起動時にスプラッシュ風の状態表示を追加（marimo の `splash.html` 相当）。最低限はステータスバー1行で OK。

#### 2-7. テスト
- `tests/sidecar/markitdown.test.js`（CI では `MARKITDOWN_E2E=1` 時のみ実行）。
- 代表的な DOCX/XLSX/PPTX を `tests/fixtures/` に追加。
- `bootstrap` 部分は Rust の `cargo test`（`uv` がインストール済みの環境前提）。

**完了条件**: 初回起動 → Python 自動 DL → markitdown install → 主要 5 形式（DOCX/PPTX/XLSX/HTML/PNG）の変換が成功。インストーラサイズは現行 +20MB 以内。

### フェーズ3 (オプション): LLM 連携の入口
- 変換結果をそのまま要約・翻訳するボタンを追加（API キーは設定画面で保持）。  
- 本計画の範囲外。別 RFC を切る。

---

## 5. リスクと対応

| リスク | 影響 | 対応 |
|--------|------|------|
| バンドルサイズ増（uv 同梱のみ） | +約15MB | 許容範囲。PyInstaller 案より遥かに小さい |
| 初回起動時の Python DL 失敗 (オフライン/プロキシ) | 起動不能 | エラー時は分かりやすく案内し、リトライ導線を出す。社内配布では事前にプロキシ設定 or `UV_PYTHON_INSTALL_MIRROR` を環境変数で指定可能にする |
| 初回起動の待ち時間（30秒〜1分） | UX 低下 | スプラッシュで進捗 (Resolved / Downloading / Installed) を表示。marimo と同じ `parse_pip_progress` ロジックを流用 |
| `app_data_dir` 容量肥大 (~300MB: Python + venv) | ストレージ圧迫 | 設定画面に「環境を再構築」「環境を削除」を用意 |
| Defender / SmartScreen | 配布事故リスクは低い (uv 公式バイナリ + アプリ署名で十分) | コード署名証明書を導入 |
| markitdown / uv のライセンス | MIT / Apache-2.0 互換 | `LICENSE-THIRD-PARTY.md` に追記 |
| OCR / 音声系の追加依存 (Tesseract / ffmpeg) | extras を入れると `pip install` が肥大 | `[all]` ではなく `[docx,pptx,xlsx,outlook,xls]` 等に限定。OCR 必要時は別フェーズ |
| PDF→MD 精度（フェーズ1） | 表・段組で破綻 | フェーズ2 完了後は PDF も markitdown 経由に切替できる抽象化レイヤーを最初から入れる |
| markitdown / Python のバージョン更新 | venv が古いまま放置 | アプリ起動時にバージョン比較し、差分があれば `uv pip install --upgrade` を実行（marimo と同じ思想） |

---

## 6. 影響範囲チェックリスト

- [ ] `package.json`: フェーズ1では追加依存なし
- [ ] `src/app.js`: ツールバー結線、変換 API への入口、ブートストラップ進捗表示
- [ ] `src/markdown/`: 新規ディレクトリ（`pdfToMarkdown.js`, `convert.js`）
- [ ] `src-tauri/Cargo.toml`: `anyhow`, `log` 追加（`tauri-plugin-shell` は **不要**、std::process::Command で十分）
- [ ] `src-tauri/binaries/uv.exe`: 同梱（`fetch-uv.js` で取得 → `.gitignore` に追加）
- [ ] `src-tauri/resources/markitdown-deps/pyproject.toml`: 新設（依存固定）
- [ ] `src-tauri/src/paths.rs`: marimo から流用
- [ ] `src-tauri/src/markitdown/{mod.rs,bootstrap.rs,commands.rs}`: 新設
- [ ] `src-tauri/src/lib.rs`: コマンド登録、`setup()` でブートストラップ起動
- [ ] `src-tauri/tauri.conf.json`: `bundle.resources` に `binaries/uv*` と `resources/markitdown-deps/**` 追加
- [ ] `src-tauri/capabilities/default.json`: 既存のまま（追加不要）
- [ ] `tests/`: 新規テストとフィクスチャ
- [ ] `README.md`: 機能追記、初回起動時に Python が自動 DL される旨を明記
- [ ] `LICENSE-THIRD-PARTY.md`: markitdown / uv / Python (PSF) の表記

---

## 7. マイルストーン目安

| フェーズ | 想定工数 | 成果物 |
|----------|----------|--------|
| 1. PDF→MD (純JS) | 2〜3日 | コピー/保存ボタン、vitest グリーン |
| 2. uv ブートストラップ + markitdown | 3〜5日 | marimo の `bootstrap.rs` を流用するため工数小。Win 版で多形式変換動作 |
| 2.x macOS/Linux 対応 | +1〜2日 | `uv` を OS ごとに同梱、`paths.rs` の OS 分岐を使用 |

---

## 8. 未決事項（要レビュー）

1. **フェーズ1の精度で十分か** — 表や段組が崩れる前提で出すか、最初からフェーズ2まで一気にやるか。
2. **初回オフライン起動の許容** — 案A' は初回に Python DL が必要。完全オフラインでの初回起動が要件なら、案A（PyInstaller 凍結）と組み合わせるか、Python 配布物を同梱する必要がある（+30MB）。
3. **対応形式の優先順位** — DOCX/PPTX/XLSX/HTML/画像 のうちどれが必須か。extras を絞ってサイズと初回 install 時間を最小化したい。
4. **配布チャネル** — 現状 Windows のみ。macOS/Linux のサポート優先度（uv は全 OS 対応なのでコスト小）。
5. **bundled marimo 方式 vs PyPI install** — marimo は同梱ソースを `uv pip install <path>` するが、本件では markitdown は PyPI から普通に install で十分。社内ネットからの PyPI 到達性のみ確認したい。

上記レビュー後、フェーズ1のチケットへ着手する。
