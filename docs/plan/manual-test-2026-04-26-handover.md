# 引継ぎ依頼: PDF Viewer フェーズ1 手動テスト（実機視認パート）

**作成日**: 2026-04-26
**作業者向け**: このプロジェクトを **何も知らない前提** で、本書だけを上から読んで実施できるように書いています。
**所要時間**: 90〜150 分（中断可、ケース単位で再開可）
**前提知識**: Windows 11 / DevTools の Console と Performance タブ / タスクマネージャの基本操作

---

## 0. これは何の作業？

`C:\Users\sasai\Documents\PyMuPDF` にある **Tauri + PDF.js 製の PDF Viewer** に、フェーズ1 で「PDF → Markdown 変換」機能が追加されました。
ユニットテスト（npm run test）は緑なので、**ここから先は「アプリを実際に起動して画面を見ないと分からない部分」を確認するのがあなたの仕事** です。

具体的には:
- ボタンを押す / ファイルを開く / クリップボードにコピーするといった **実機操作** の動作確認
- ターミナルに出る Rust の WARN ログ件数を **目で数える**
- タスクマネージャでメモリ使用量を **計測する**
- DevTools の Console で例外が出ていないか **眺める**

AI（Claude Code）が事前に済ませてあること:
- ✅ ユニットテスト（103 件）緑、カバレッジ閾値クリア
- ✅ テスト用 PDF ファイル 11 件をすべて生成済（`tests/fixtures/manual/` に配置）
- ✅ リリースビルド（NSIS インストーラ）作成済、サイズ基準クリア
- ✅ 実装の grep 確認・capabilities 静的検査済

つまり **「もうあとは実機で目視するだけ」** の状態でバトンを渡しています。

---

## 1. 用意するもの / 環境準備

### 1-1. ツール

- **Windows 11**（このリポジトリは Windows 一次ターゲット）
- **Node.js** + `npm`（`npm run` が使える状態）
- **Rust toolchain**（Tauri が要求、すでに入っているはず）
- **VS Code** か、Markdown を表示できるエディタ（F2 検証で使う）
- **タスクマネージャ**（Ctrl+Shift+Esc で開ける標準ツール）

### 1-2. リポジトリの場所

```
C:\Users\sasai\Documents\PyMuPDF
```

以降のコマンドは **すべてこのディレクトリで実行** してください。

### 1-3. 関係するファイルだけ覚えればよい

| ファイル | 役割 |
|---|---|
| `docs/plan/manual-test-plan-2026-04-26.md` | **手順書本体**（497 行）。本書はこの抜粋＋補足です |
| `docs/plan/manual-test-2026-04-26-execution.md` | **AI 部分の実施記録**。あなたはここに追記する |
| `tests/fixtures/manual/` | 手動テスト用 PDF（11 件、生成済） |
| `tests/test.pdf` / `test2.pdf` / `test3.pdf` | 既存のサンプル PDF |
| `docs/plan/manual-test-2026-04-26-logs/` | ログ保存先（空ディレクトリ、あなたが埋める）|

---

## 2. 全体の流れ（ざっくり）

1. アプリを **開発モード** で起動（ログ付き）
2. **§5-A〜H の各ケース** を順に実行（A → B → C → D → E → F → G → H）
3. 各ケースの結果を **`docs/plan/manual-test-2026-04-26-execution.md`** に書き込む
4. ❌（不一致）が出たら **再現手順とログを保存**（破棄しない、後で原因究明する）
5. 全部終わったら、**完了報告** を作成者に返す

「上から順に消化」できる構成にしてあります。**飛ばしたいケースが出たら一旦保留**してください。最後にまとめて再開できます。

---

## 3. 起動手順（最重要）

### 3-1. 開発モード起動

PowerShell を開いて、リポジトリのルートに移動してから以下:

```powershell
cd C:\Users\sasai\Documents\PyMuPDF
$env:RUST_LOG="warn"
npm run tauri dev
```

`RUST_LOG=warn` を **必ず設定** してください。これがないと Rust 側の WARN ログが見えず、本テストの主目的（報告済み tao WARN の再現確認）ができません。

数十秒〜1 分でアプリウィンドウが開きます。

### 3-2. DevTools を開く

アプリウィンドウで `Ctrl + Shift + I` を押すと DevTools が開きます。

- **Console タブ**: 設定（歯車アイコン）→ "Preserve log" を **ON** にする
- **Performance タブ**: 録画したいときに使う（任意、§4-1 の手順参照）

### 3-3. ターミナル / アプリ / DevTools の 3 画面体制

作業中、以下の 3 つを **同時に並べて見られる状態** にしておくとはかどります:

1. **PowerShell ターミナル**（`tauri dev` を起動した画面）→ ここに `tao::*` `wry::*` の WARN が流れる
2. **PDF Viewer のアプリウィンドウ** → ボタン操作はここ
3. **DevTools**（アプリ内、Ctrl+Shift+I）→ Console と Performance を見る

---

## 4. 最初に必ずやること: ベースライン B0 の計測

これをやらないと **以降のすべてのケースが判定不能** になります。

### 4-1. B0 とは

「アプリを起動した直後の 5 秒間に、ターミナルに出る `tao::*` または `wry::*` の WARN 行数」です。
このベースラインを取らないと、「F1 を押したときに増えた WARN は本当に F1 のせいか？」が判断できません。

### 4-2. 手順

1. ターミナルを **クリア** してから `npm run tauri dev` 実行
2. アプリが起動したらストップウォッチで **5 秒** 計測
3. 5 秒間にターミナルに流れた WARN 行のうち、`tao::` または `wry::` を **含む行だけ** 数える
4. その件数を `B0 = ___ 件` として **`execution.md` の §3 事前定数表に書き込む**

> 例: 起動から 5 秒で `[tao::platform_impl::...] WARN ...` が 3 行流れた → **B0 = 3**

### 4-3. WARN の見つけ方

PowerShell でログをファイルに落としておくのも手です:

```powershell
# 別ターミナルで grep 用にコピーしておきたい場合
Get-Content -Wait <stdout> | Select-String "tao::|wry::"
```

簡単には、ターミナルに流れる赤系の `WARN` 行を目で数えるだけで OK です。

---

## 5. ケース実施 — どう判定するか

### 5-1. 判定マークは 4 種類

`docs/plan/manual-test-2026-04-26-execution.md` を開いて、§4-1〜§4-8 の表の各セルに以下のいずれかを記入してください:

| マーク | 意味 |
|---|---|
| `✅` | 期待通りに動いた |
| `❌` | 期待と違う動作。**再現手順とログ抜粋を必ずセットで残す** |
| `N/A` | 実装が無いと事前 grep で確定したケースのみ。今回は該当なし（A5/B5/C5/D/F1/F5/F9 は実装済と AI が確認済）|
| `HUMAN_REQUIRED` | 既に書かれているはず。あなたが視認したら `✅`/`❌` に上書き |

### 5-2. ❌ を書くときに必ず一緒に書くもの

```markdown
| F5 | ❌ | スキャン PDF を開いたが「テキストを抽出できませんでした」が **0.5 秒で消えた**（期待 3 秒以上）。
       ステータスバーが空白に戻ってしまい、ユーザーには成功か失敗か分からない。
       再現: scanned_image_only.pdf を開く → MDコピー → ステータスバーを目で計測（3 回計測 すべて 1 秒未満）。
       ログ: docs/plan/manual-test-2026-04-26-logs/F5-console.log を参照。 |
```

**書く内容**:
- 何をしたか（再現手順）
- 何が起きたか（実際の動作）
- 何を期待していたか（差分）
- ログファイル名（保存していれば）

### 5-3. ログの保存先と命名

```
docs/plan/manual-test-2026-04-26-logs/
├── F1-tao.log         (ターミナル出力をコピペ保存)
├── F1-tao-warn.log    (上記から `tao::|wry::` だけ抽出した版)
├── F1-console.log     (DevTools Console タブ → 右クリック → "Save as...")
├── F1-perf.json       (Performance タブの ⤓ Save profile、任意)
├── F1-mem.csv         (タスクマネージャの値を 5 秒間隔 3 行で手書き、任意)
├── F5-console.log
└── ...
```

**フォーマット詳細は計画書 §4-1 表を参照**。完璧でなくて OK。**❌ のときだけは絶対に保存** してください。

---

## 6. ケース一覧と優先度（消化順序）

詳細な操作手順は **`docs/plan/manual-test-plan-2026-04-26.md` の §5-A〜H の表** に書いてあります。本書ではダブらないよう一覧と優先度だけ示します。

### 6-A. 起動 / ファイル開閉（A1〜A9） — **最優先**

| # | やること | 期待 |
|---|---|---|
| A1 | アプリ起動 | Welcome 画面、prev/next/MD ボタンが disabled、**B0 を計測** |
| A2 | `tests/test2.pdf` を開く | 1 ページ目描画、ファイル名表示 |
| A3 | A2 の後に `tests/test3.pdf` を開く | 切り替わる、前 PDF の canvas が残らない、検索/TOC/zoom が初期化 |
| A3-r | F1 を押した直後（変換中）に A3 を実行 | 旧変換が abort、console に AbortError 1 件のみ |
| A4 | 「開く」→ ダイアログをキャンセル | 何も起きない |
| A5 (a) | ウィンドウに `tests/test2.pdf` をドラッグ＆ドロップ | A2 と同じ動作 |
| A5 (b) | `.pdf` 以外（メモ帳の `.txt` 等）をドロップ | 何も起きない（無視される） |
| A6 | `tests/fixtures/manual/error/corrupted.pdf` を開く | エラー文言（破損 PDF 系）、Welcome 復帰、クラッシュなし |
| A7 | `tests/fixtures/manual/error/password.pdf` を開く | エラー文言（パスワード保護）、PasswordException 1 件 |
| A8 | `tests/fixtures/manual/error/empty.pdf`（0 byte）を開く | エラー文言、Welcome 復帰 |
| A9 | `tests/fixtures/manual/error/fake.pdf`（PNG リネーム）を開く | エラー文言、Welcome 復帰 |

### 6-B. ページめくり（B1〜B6） — A2 完了後

「次へ」「前へ」ボタン連打、ページ番号入力、異常値入力（`-1` / `9999` / `1.5` / `Infinity` / 全角 `１` / 空 / スペース / ペースト `1 2`）、矢印キー / PageDown / Home / End。

**B4 だけ細かい**: 計画書の `B4` セルにある異常値リストを **全部** 試して、すべてクラッシュしないことを確認。

### 6-C. ズーム（C1〜C5） — A2 完了後

拡大 5 連打 / 縮小 5 連打 / 幅に合わせる / リサイズ → C3 / `Ctrl+ホイール` ズーム / `Shift+ホイール` ページ送り。

### 6-D. 検索（D1〜D3） — **仕様注意**

フェーズ1 の検索は **現ページ内の文字ハイライトだけ**（クロスページ遷移・件数表示・次/前送りはまだ実装されていない）。
ヒットなしでもクラッシュしなければ OK。

### 6-E. TOC / サムネ / 小口（E1〜E6） — `with_toc.pdf` 使用

| # | やること | 期待 |
|---|---|---|
| E1 | `tests/fixtures/manual/with_toc.pdf` を開いて「目次」ボタン | サイドバーに **3 エントリ**（Section 1/2/3） |
| E2 | TOC エントリクリック | 該当ページ（page 1/5/10）へジャンプ |
| E3 | 「サムネイル」タブ | 全 50 ページのサムネイル生成 |
| E4 | サムネクリック | 該当ページへジャンプ |
| E5 | `tests/fixtures/manual/multipage_50p.pdf` の小口（本のエッジ）描画 | **edge 49 本**（AI が事前に計算済: `calcEdgeCount(50)=49`） |
| E6 | 1 ページのみの PDF（`tests/test.pdf` でも可、2 ページなので近い）で edge 描画 | edge 0 本、警告なし |

### 6-F. Markdown コピー / 保存（F1〜F9） — **本作業の中核**

これがフェーズ1 の新機能。最重要セクションです。

| # | やること | 期待 |
|---|---|---|
| **F1** | `tests/test2.pdf` を開く → 「MDコピー」ボタン | クリップボードに Markdown が入る、ステータスバーに完了文言。**ターミナルに `tao` WARN が増えるか観察、件数記録** |
| F1-cb | F1 直後に DevTools Console で `await navigator.clipboard.readText()` 実行 | 出力文字列に `# `（H1 マーカー）が含まれる、文字数 > 0 |
| F1-deny | DevTools Console で以下を実行 → F1 押下 | ステータスバーに **明示的なエラー文言**（成功扱いになったら ❌） |
| F2 | F1 後にエディタへペースト | (a) `^# ` 正規表現でヒット ≥1 / (b) 段落間に空行 / (c) `^\[.+\]\(https?://` でリンク行 ≥1（リンクは F8 検証時に確認） |
| F2-uni | `tests/fixtures/manual/unicode.pdf` で F1 → ペースト | (d) `𠮷` (1 グリフ) / (e) Arabic 論理順 / (f) 縦書き論理順。**注**: この PDF は reportlab 生成のため Arabic/縦書きの厳密検証はできない。CJK の `𠮷` だけは確認できる |
| **F3** | 「MD 保存」→ `$DOCUMENT/test.md` で保存 | `.md` ファイル作成、F2 と同等の内容 |
| F3-overwrite | 既存 `.md` 上書き | 上書き成功 |
| F3-ext | 拡張子 `.txt` で保存 | **拒否される** |
| F3-home | `$HOME` 直下で `.md` 保存 | **拒否される** |
| F4 | 保存ダイアログをキャンセル | 何も起きない |
| **F5** | `tests/fixtures/manual/scanned_image_only.pdf` で MDコピー | (a) clipboard 空 or プレースホルダ / (b) **「テキストを抽出できませんでした」が 3 秒以上表示** / (c) クラッシュなし。**3 つ全部** |
| F6 | `tests/fixtures/manual/multipage_50p.pdf` で MDコピー | 数秒で完了、UI フリーズせず、**メモリ増分 +200MB 以下** |
| F6-abort | F6 変換中に A3（別 PDF を開く） | 旧変換 abort、console に AbortError 1 件 |
| F7 | F1 → ページ移動 → F1 再実行 | **同一 PDF なら 2 回とも同一の MD** |
| **F8** | `tests/fixtures/manual/with_links.pdf` で MDコピー | (a) http(s) / (b) 内部 anchor / (c) `mailto:` は `[text](url)` 形式 / (d) `javascript:` / (e) `data:` は **テキストのみ**（リンクとして出ない） |
| F8-evil | `tests/fixtures/manual/with_links_evil.pdf` で MDコピー | `javascript:` / `data:` / `vbscript:` が **MD に現れない** |
| F9 | `tests/fixtures/manual/partial_broken.pdf` で MDコピー | 完了文言にサフィックス「（**3** ページ抽出失敗: **3, 7, 12**）」 |

#### F1-deny で実行する Console コマンド

```javascript
navigator.clipboard.writeText = () => Promise.reject(
  new DOMException('blocked', 'NotAllowedError')
);
```

これを実行してから「MDコピー」を押すと、書き込みが必ず失敗する状態になります。**ステータスバーに何も出ない / 成功扱いになる場合は ❌**。

#### F1 で WARN が増えたら追加調査

計画書本体の **§5-F「F1 切り分け手順 (順序固定)」(0)〜(5)** を上から順に実施してください。コピペ可能なコードスニペット込みで書いてあります。

#### F6 のメモリ計測手順

1. タスクマネージャ → 「詳細」タブ → 列に「メモリ（アクティブなプライベート ワーキング セット）」を追加
2. プロセス: dev では `app.exe` 系 + `msedgewebview2.exe` を **すべて合算**
3. F6 実行 **前** の合算値 = `M_pre`
4. F6 実行 **中〜直後** の最大値 = `M_post(max)`、3 回計測して最大を採用
5. `M_post - M_pre` が +200MB 以下なら ✅

### 6-G. 長時間ストレス（G1〜G3） — 最終盤

| # | やること | 期待 |
|---|---|---|
| G1 | 5 周（1 周 60 秒、計 5 分）固定順序: 次へ×3 → 拡大×2 → MDコピー×1 → 縮小×2 → 前へ×3 → `tests/test3.pdf` を開く → `tests/test.pdf` を開く（test2.pdf は 296MB と大きいので test.pdf で代用推奨）| クラッシュなし。M0(開始) / M3(3 分時) / M5(終了時) を記録、`(M5-M0) > 1.5 × (M3-M0)` なら ❌ |
| G2 | G1 中の `tao` WARN 件数 / 分 | 操作回数比例、急増しない |
| G3 | 異なる PDF を 5 連続で開閉 | RSS 増分 +50MB 以下 |

### 6-H. リリースビルド検証（H1〜H3-x） — **dev 完了後**

H1 は **AI が既に完了**: NSIS = 2,717,157 bytes / B_size 差 -1,587 bytes / +1MB 基準クリア ✅

H2 以降は実機:

1. `src-tauri/target/release/bundle/nsis/PDF Viewer_0.1.0_x64-setup.exe` を **インストール**
2. インストール版で **A2 / B1 / C1 / D1 / F1 / F3 を再実行**（dev と同じ結果か）
3. H3 (a)(b)(c): 保存先を変えて拒否確認（F3 系と同じだが install 版で）
4. H3-x: DevTools Console で `await window.__TAURI__.fs.writeTextFile('C:/Windows/probe.md', 'x')` 試行 → 拒否される。API が露出していなければ skip 可

---

## 7. やってはいけないこと（不可侵ルール）

1. **計画書 (`manual-test-plan-2026-04-26.md`) を編集しない**
   不備に気づいても `execution.md` の「計画書不備指摘」欄に書くだけ。
2. **`src/` `src-tauri/` のコードを編集しない**
   バグを見つけても直さない。再現手順とログを残すのがあなたの仕事。
3. **F1 切り分けでコード書き換えが必要な場合は隔離ブランチで**
   `git switch -c manual-test/probe` → 実験 → `git switch -` → `git branch -D manual-test/probe`。本流に汚染を残さない。
4. **判定に迷ったら `HUMAN_REQUIRED` のまま放置せず、依頼者に質問する**
   勝手に `✅` を埋めない。

---

## 8. 完了したら

### 8-1. `execution.md` の §8 サマリを完成させる

特に以下を埋める:
- B0 の値
- tao WARN 集計（B1 / C1 / F1 / F3 / G1）
- メモリ計測（F6 / G1 / G3）
- A〜H の各セルが `HUMAN_REQUIRED` から `✅`/`❌` に置き換わっていること

### 8-2. ❌ がゼロなら「合格」報告

依頼者に以下のように報告:
```
合格です。
- 全ケース ✅
- F1 の tao WARN: B0+__件 / クリック1回（再現あり/なし）
- 計画書不備指摘: __件（execution.md §6 参照）
```

### 8-3. ❌ が 1 件以上あったら「条件付き不合格」報告

```
不合格、❌ N件:
- F5: <現象サマリ> / 詳細 execution.md §7-1
- F8-evil: ...
依頼者の判断を仰ぎます。
```

❌ になったケースは **計画書 §7 自動化候補** に追加して issue 化（3 ヶ月以内に E2E 化）が推奨されているので、その案も添えると親切です。

---

## 9. 詰まったら / 質問したいとき

**その場で止めて依頼者に質問してください**。以下のような状況は迷わず聞いて OK:

- ターミナルに `error` が出てアプリが起動しない
- 計画書の手順と画面が違う（UI 変更があったかも？）
- 「期待結果」の文言が UI に見当たらない
- メモリ計測の対象プロセスが特定できない（webview2 の子プロセスが多すぎる等）
- F1 の WARN が出るが、計画書の切り分け手順 (3) でモンキーパッチを実行しても消えない

**判断に迷ったまま `✅` を埋めると、後でフェーズ2 に持ち込まれてもっと厄介になります**。

---

## 10. 参考: AI が事前に確認した事実

実機検証で「あれ、これおかしいな」と思ったときの判断材料:

- ✅ ユニットテスト 103 件全件緑（`pdfToMarkdown.test.js` 31 / `convert.test.js` 9 / `book-edge.test.js` 31 / `pdf-viewer.test.js` 32）
- ✅ カバレッジ `src/markdown/**` 合算で lines 91.63% / branches 75% / funcs 94.59% / stmts 89.87%
- ✅ NSIS リリースビルド 2,717,157 bytes（B_size 2,718,744 bytes と -1,587 bytes 差）
- ✅ `app.js:404` に「テキストを抽出できませんでした（スキャン PDF の可能性）」実装あり
- ✅ `app.js:430-435` に `mdResultSuffix`（「N ページ抽出失敗: ...」）実装あり
- ✅ `app.js:1077` に `handleSearch`（**現ページ内ハイライトのみ**、クロスページ遷移は仕様外）
- ✅ `app.js:1118-1127` にキーボードハンドラ（ArrowRight/PageDown/Home/End）
- ✅ `app.js:1166` に `handleWheel`（Ctrl+ホイール ズーム / Shift+ホイール ページ送り）
- ✅ `app.js:1257-1270` にドラッグ＆ドロップ（`.pdf` のみ受理、それ以外は silent ignore）
- ✅ `app.js:1276` に `open-pdf` イベントリスナ（Tauri 環境のみ）
- ✅ `src-tauri/capabilities/default.json` の `fs:allow-write-text-file` は `$DOCUMENT/$DESKTOP/$DOWNLOAD` の `**/*.md` のみ allow（→ F3-ext / F3-home の拒否は capabilities 由来で確実）

---

## 付録: 「これだけは見ておけ」要約

時間が無くて全部回せない場合の最小セット（合否基準 §6 必須項目だけ）:

1. **A1** (B0 計測)
2. **A2** (通常ファイル開く)
3. **F1** (MDコピー + tao WARN 観察) ← フェーズ1 の中核
4. **F5** (スキャン PDF のエラー文言) ← 合否必須
5. **F8-evil** (危険 URL サニタイズ) ← セキュリティ系

これだけで **§6 「必須」要件** はカバーできます。残りは「推奨」です。

---

以上です。実機実施をよろしくお願いします。

不明点 / 詰まりは依頼者にすぐ聞いてください。**判断保留 OK、勝手な ✅ NG**。
