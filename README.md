# PDF Viewer

Tauri v2 と PDF.js を使用して構築された、高速でモダンなデスクトップ向け PDF ビューアアプリケーションです。

## アプリケーション構成

本アプリケーションは、以下の技術スタックを組み合わせて構築されています。

*   **フロントエンド**: HTML / Vanilla CSS / Vanilla JS + Vite
*   **バックエンド (デスクトップシェル)**: Tauri v2 (Rust)
*   **PDF レンダリングコア**: PDF.js (`pdfjs-dist`)

**構成の特徴:**
PyMuPDFを使用したPython sidecar構成から脱却し、**Tauri プラグインと PDF.js のみで完結するシンプルで強力なアーキテクチャ**を採用しています。これにより、Python環境への依存やバンドルの複雑さが解消され、軽量で高速な配布・実行が可能になっています。

---

## 主な機能 (仕様)

*   **PDFファイルの表示**: 
    *   Tauri の `plugin-dialog` でネイティブのファイル選択ダイアログを表示。
    *   Tauri の `plugin-fs` を使用してローカルファイルを高速に読み込み (`Uint8Array`化)。
    *   PDF.js により高画質でキャンバス (Canvas) にレンダリング。
*   **ページナビゲーション**:
    *   「前へ」「次へ」ボタンによる移動。
    *   ページ番号の直接入力によるジャンプ。
*   **ズームと表示制御**:
    *   「拡大」「縮小」ボタンによるスケール変更。
    *   「幅に合わせる」機能でウィンドウサイズにフィット。
    *   ※ `Ctrl/Cmd` + マウスホイールによるスムーズなズーム対応。
*   **テキスト検索**:
    *   PDF.js の生成するテキストレイヤー (`text-layer`) に対する透過的なハイライト検索。
    *   入力ごとにリアルタイムで一致するテキストをハイライト表示。
*   **目次 (Table of Contents)**:
    *   PDF内のアウトライン (しおり) を抽出し、サイドパネルに階層構造で表示。
    *   目次項目をクリックすることで、該当の宛先 (Destination) ・ページへ即座に移動可能。
*   **ダークモード UI**:
    *   眼に優しいダークテーマベースのモダンなデザイン (Glassmorphism などを活用)。
*   **キーボードショートカット**:
    *   `←` / `→` (または `PageUp` / `PageDown`): ページ移動
    *   `Home` / `End`: 最初 / 最後のページへ移動
    *   `Ctrl/Cmd` + `+` / `-`: ズームイン / ズームアウト
    *   `Ctrl/Cmd` + `0`: ズームリセット (100%)
    *   `Ctrl/Cmd` + `O`: ファイルを開く
    *   `Ctrl/Cmd` + `F`: テキスト検索にフォーカス

---

## ディレクトリ構造

```text
PyMuPDF/
├── src/                      # フロントエンドのソースコード
│   ├── index.html            # UIの骨組み
│   ├── style.css             # ダークモード対応のデザイン
│   └── app.js                # PDF.js の制御と Tauri API 連携ロジック
├── src-tauri/                # Tauri (Rust) バックエンドの設定
│   ├── capabilities/
│   │   └── default.json      # ファイル・ダイアログ操作の権限設定
│   ├── src/
│   │   ├── main.rs           # エントリポイント
│   │   └── lib.rs            # プラグイン (fs, dialog) の初期登録
│   ├── Cargo.toml            # Rust の依存関係
│   └── tauri.conf.json       # アプリケーションのウィンドウやビルド設定
├── package.json              # npm パッケージ (Vite, PDF.js, Tauri APIs)
└── vite.config.js            # Vite のビルド・開発サーバー設定
```

---

## 開発環境のセットアップと起動手順

### 必要な環境
*   [Node.js](https://nodejs.org/) (v16 以降推奨)
*   [Rust](https://www.rust-lang.org/) (Cargo 含む)
*   各種 OS における C++ ビルドツール (Windows の場合は `Desktop development with C++`)

### 起動手順

1. 依存パッケージのインストール
```powershell
npm install
```

2. 開発サーバーと Tauri アプリの起動
```powershell
npm run tauri dev
```
※ 初回起動時は Rust クレート (約400個) のコンパイルが走るため、数分時間がかかります。2回目以降は即座に起動します。

### Windowsインストーラーの生成

#### ビルドコマンド

```powershell
npm run tauri build
```

> ⚠️ **初回ビルドは数分かかります。** Rust クレートのコンパイルが約 470 個走るため時間がかかりますが、2回目以降は差分コンパイルのみで大幅に短縮されます。

---

#### 生成される成果物

ビルド完了後、以下の 2 種類のインストーラーが自動生成されます。

| 形式 | パス | 説明 |
|------|------|------|
| **NSIS インストーラー** (`.exe`) | `src-tauri\target\release\bundle\nsis\PDF Viewer_0.1.0_x64-setup.exe` | 一般的なウィザード形式のインストーラー。**通常の配布はこちらを推奨** |
| **MSI インストーラー** (`.msi`) | `src-tauri\target\release\bundle\msi\PDF Viewer_0.1.0_x64_en-US.msi` | Windows Installer 形式。企業向けのグループポリシー配布などに対応 |

アプリ本体の実行ファイル単体は以下に出力されます。

```
src-tauri\target\release\app.exe
```

---

#### インストーラーの使い方

1. `PDF Viewer_0.1.0_x64-setup.exe` をダブルクリック
2. インストールウィザードに従って操作
3. スタートメニューまたはデスクトップのショートカットからアプリを起動

---

#### 動作要件 (配布先 PC)

| 項目 | 要件 |
|------|------|
| OS | Windows 10 / 11 (64-bit) |
| WebView2 | Microsoft Edge WebView2 ランタイム (Windows 11 は標準搭載。Windows 10 は未導入の場合インストーラーが自動セットアップ) |
| 追加ランタイム | 不要 (Node.js / Python / Rust は不要) |
