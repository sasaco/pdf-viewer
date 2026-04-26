# 動作テスト計画 (2026-04-26)

## 0. 本計画書の使い方（必読）

本計画書は **冷えた実施者（前後文脈を持たない作業者）が、上から順に実行するだけで完遂できる** ことを目標としている。
N/A 判定はチェックリスト消化の抜け道として使わない。「実装が無いから N/A」は §5-0-A の grep 手順で確認した上で、実装の不存在を **記録する** 形で残す。

実施フローの骨子:

1. §1 目的 / §2 前提 / §2-A フィクスチャ準備 を読む
2. §3-0 ゲート（vitest/coverage 緑）を通す。落ちたら本計画は中断
3. §3-1 で `RUST_LOG=warn` 起動 → §4 ベースライン (B0) を測定
4. §5-0 実行順序に従い A→B→C→D→E→F→G→H を消化
5. §8 テンプレに記録

---

## 1. 目的

MarkItDown 導入フェーズ1（PDF→Markdown 純JS）実装後、ユニットテスト (`vitest`) だけでは捕捉できない以下の領域を手動 + 半自動で網羅する。

- Tauri ランタイム（webview2 / tao / wry）上でのみ再現する事象
  - 例: 報告された警告
    ```
    [tao::platform_impl::platform::event_loop::runner][WARN] NewEvents emitted without explicit RedrawEventsCleared
    [tao::platform_impl::platform::event_loop::runner][WARN] RedrawEventsCleared emitted without explicit MainEventsCleared
    ```
  - vitest+jsdom では出ない、ネイティブのイベントループ警告。
- 既存の **PDF Viewer 基本機能**（ページめくり / ズーム / 検索 / 目次 / サムネイル / 本の小口表現）の MD 機能追加による回帰。
- ユーザー操作の連鎖（開く→めくる→拡大→検索→MD コピー→保存）の整合性。
- エラー経路（破損 PDF / パスワード / 空 / 偽拡張子 / 部分失敗）。

## 2. 前提

| 項目 | 値 |
|------|----|
| OS | Windows 11（一次ターゲット） |
| ビルド | `npm run tauri dev`（開発）、`npm run tauri build`（NSIS リリース） |
| Tauri | 2.10（`src-tauri/Cargo.toml`） |
| productName | `PDF Viewer`（リリース実行ファイル名はこの名称＋OSの慣習に従う / `tauri.conf.json` 参照） |
| 実行者 | 1 名（チェックリスト記入式） |
| 想定所要 | 90〜150 分（フィクスチャ作成済み前提、初回は +60 分） |
| 記録 | 各ケースを ✅ / ❌ / N/A で記入し、❌ は再現手順とログ抜粋を残す |
| ログ保存先 | `docs/plan/manual-test-2026-04-26-logs/` 配下（実施者がローカル作成、git 管理外）|

### 2-A. フィクスチャ準備（CRITICAL: 実施前に揃える）

`tests/` 直下の既存 PDF（`test.pdf`/`test2.pdf`/`test3.pdf`/`api_request_if_v4r7.pdf`）はそのまま使う。本計画で追加で必要な PDF は次の通り。すべて `tests/fixtures/manual/` 配下に配置する（git 管理外推奨）。

| ファイル | 用途 | 作成方法（推奨） |
|---|---|---|
| `multipage_50p.pdf` | F6 / E5（50ページ規模） | `qpdf --collate -- test3.pdf test3.pdf test3.pdf ... multipage_50p.pdf`（合計 50 ページ以上になるまで連結） |
| `scanned_image_only.pdf` | F5（テキスト層なし） | `qpdf --pages test2.pdf 1 -- in.pdf out.pdf` で 1 ページ抜き出し → ImageMagick で `magick out.pdf -density 150 page.png` → `magick page.png scanned_image_only.pdf`（PNG→PDF 化でテキスト層を破棄） |
| `with_toc.pdf` | E1/E2 | **本命**: LibreOffice Writer で「見出し 1 / 見出し 2」スタイル付き docx を作成 → `File > Export As > Export as PDF`（PDF/A 不要、`Tagged PDF` ON、`Export bookmarks` ON）。**代替**: Python `pikepdf` で最小スクリプト — `import pikepdf; pdf=pikepdf.open('test3.pdf'); with pdf.open_outline() as o: o.root.append(pikepdf.OutlineItem('Sec1', 0)); o.root.append(pikepdf.OutlineItem('Sec2', 1)); pdf.save('with_toc.pdf')`（旧来の `qpdf --replace-input --json='...outlines...'` 構文は qpdf に存在しないため使用不可） |
| `with_links.pdf` | F8（外部 URL リンク） | LibreOffice Writer で `https://example.com` / `mailto:test@example.com` / `#anchor` を含む docx を作成 → `File > Export As PDF` |
| `with_links_evil.pdf` | F8 拡張（危険スキーム） | 同上で `javascript:alert(1)` / `data:text/html,...` / `vbscript:` を含む docx → PDF |
| `unicode.pdf` | H10（CJK / 絵文字 / RTL / 縦書き） | LibreOffice Writer で `🎉 𠮷野家`（U+20BB7）/ アラビア 1 段落 / `vertical-rl` 1 段落 を入れた docx → PDF |
| `partial_broken.pdf` | F9（部分失敗） | **本命** (Python + pikepdf): 以下のスニペットで page index 2/6/11 (1-based 3/7/12) の `/Contents` を空 stream に差し替える。<br>`import pikepdf; pdf=pikepdf.open('multipage_50p.pdf'); empty=pikepdf.Stream(pdf, b''); for i in (2,6,11): pdf.pages[i].Contents = empty; pdf.save('partial_broken.pdf')`<br>**代替**（物理破壊）: `qpdf --qdf --object-streams=disable multipage_50p.pdf qdf.pdf` → エディタで該当ページの `stream`〜`endstream` 中身先頭 4 バイトを 0x00 で上書き → `fix-qdf qdf.pdf > partial_broken.pdf` |
| `error/corrupted.pdf` | A6 | unix: `head -c 1024 test2.pdf > error/corrupted.pdf`（先頭 1KB のみ）<br>PowerShell: `[IO.File]::WriteAllBytes('tests\fixtures\manual\error\corrupted.pdf', [IO.File]::ReadAllBytes('tests\test2.pdf')[0..1023])` |
| `error/password.pdf` | A7 | `qpdf --encrypt user owner 256 -- test2.pdf error/password.pdf`（PowerShell でも同じ） |
| `error/empty.pdf` | A8 | unix: `: > error/empty.pdf`（0 バイト）<br>PowerShell: `New-Item tests\fixtures\manual\error\empty.pdf -ItemType File -Force` |
| `error/fake.pdf` | A9 | unix: `cp some.png error/fake.pdf`（PNG リネーム）<br>PowerShell: `Copy-Item tests\some.png tests\fixtures\manual\error\fake.pdf` |

#### 2-A-1. 配置確認スクリプト

実ファイル: **`scripts/check-manual-fixtures.js`**（R2 で作成済、Node 標準のみ依存ゼロ）。`§3-0` ゲートで `node scripts/check-manual-fixtures.js` を実行し `OK: all 11 manual fixtures present` を確認。**未配置ファイルがあれば exit 1 で列挙されて停止**するので、§2-A の作成手順に戻る。

対象 11 ファイル: `with_toc.pdf` / `multipage_50p.pdf` / `scanned_image_only.pdf` / `with_links.pdf` / `with_links_evil.pdf` / `unicode.pdf` / `partial_broken.pdf` / `error/corrupted.pdf` / `error/empty.pdf` / `error/fake.pdf` / `error/password.pdf`。

## 3. テスト方式と前提ゲート

3 層に分ける。

### 3-0. 前提ゲート（必須）

以下を満たさない場合、**本計画は中断**してまずゲートを通す。

- [ ] `npm run test` が **全件緑**（件数は §3-1 表の合計 = 実測値、§8 テンプレに記入）。1 件でも赤なら本計画は中断、まず単体テストを修正。
- [ ] `npm run coverage` の `src/markdown/**` が **lines ≥ 80% / functions ≥ 80% / branches ≥ 74% / statements ≥ 80%** を満たす（`vite.config.js` の閾値超過）。最新値は §8 テンプレに記録。
- [ ] §2-A の `node scripts/check-manual-fixtures.js` が `OK` を返す。
- [ ] `git status` がクリーン（手元の検証用書き換えが残っていない）。

### 3-1. 自動回帰（vitest, 既存）

`npm run test` でフェーズ1 で追加した抽出ロジック単体テストがグリーンであること。`package.json` の定義は `"test": "vitest run"`。対象は以下:

| ファイル | it() 件数（実測 2026-04-26）|
|---|---|
| `tests/markdown/pdfToMarkdown.test.js` | 17 |
| `tests/markdown/convert.test.js` | 9 |
| `tests/book-edge.test.js` | 31 |
| `tests/pdf-viewer.test.js` | 32 |
| **合計** | **89**（実測 2026-04-26、`npx vitest run` 出力末尾の `Tests  N passed` で再確認し §8 に記入）|

### 3-2. 半自動 E2E（追加推奨, optional）

`@tauri-apps/cli` + Playwright を介した E2E は本計画では **任意拡張**。最低限、後述の手動チェックリスト §5 を網羅すれば本フェーズ完了とみなす。E2E 化候補は §7。

### 3-3. 手動シナリオテスト（本計画の主軸, §5）

`npm run tauri dev` で起動し、開発者ツール（Ctrl+Shift+I）と `tauri dev` のターミナルログを並べて観察する。**起動コマンドは必ず `RUST_LOG` 付きで起動する**（§4 参照）。

## 4. 観察すべきログ・指標

毎ケース、以下を **同時に** 監視する。

1. **Tauri 開発ターミナル** — `tao::*` / `wry::*` の `WARN` 以上を拾う。報告済みの「NewEvents emitted without explicit RedrawEventsCleared」「RedrawEventsCleared emitted without explicit MainEventsCleared」が、どの操作トリガで増えるかをカウントする。
2. **Webview の DevTools Console** — 例外、Promise rejection、PDF.js の `Warning:` を拾う。Preserve log を ON にし、「Save as ...」で `<ケース番号>-console.log` として保存。
3. **DevTools Performance**（任意） — めくり・ズーム時のフレーム落ち。録画は「Record」→ 操作 → Stop → 「Save profile」で `<ケース番号>-perf.json`。
4. **タスクマネージャ** — メモリ確認用。`Ctrl+Shift+Esc` → 「詳細」タブ → 列見出し右クリック → 「列の選択」→ 「メモリ（アクティブなプライベート ワーキング セット）」を ON。プロセス名は dev では webview2 関連 + `app.exe` 系（Cargo の package 名から派生）、release では `PDF Viewer.exe`（`tauri.conf.json` の `productName`）+ `msedgewebview2.exe` をすべて合算した値で判定。

### 4-0. ログ起動手順（必須）

開発ターミナルで以下を実行（cmd.exe / PowerShell どちらでも、各 OS の構文に従う）:

```bat
:: Windows cmd.exe
set RUST_LOG=warn
npm run tauri dev
```
```powershell
# Windows PowerShell
$env:RUST_LOG="warn"; npm run tauri dev
```

`tao` / `wry` のみに絞りたい場合は `RUST_LOG=tao=warn,wry=warn`。

### 4-1. 観察手順詳細

| 観察対象 | 取得方法 | 保存ファイル |
|---|---|---|
| Tauri ターミナル全体 | ターミナルを丸ごと選択 → クリップボードへ → ファイルへ貼り付け、または `npm run tauri dev 2> tao.log` ※ Windows PowerShell では `2>&1` の挙動に注意 | `<ケース番号>-tao.log` |
| 該当 WARN 抽出 | `grep -E "tao::|wry::" <ケース番号>-tao.log`（PowerShell は `Select-String`） | `<ケース番号>-tao-warn.log` |
| DevTools Console | Console タブ → 設定 (歯車) → Preserve log ON → 右クリック「Save as...」 | `<ケース番号>-console.log` |
| Performance | Performance タブ → Record → 操作 → Stop → ⤓ Save profile | `<ケース番号>-perf.json` |
| メモリ計測 | タスクマネージャの値を 5 秒間隔で 3 行記録（手書き or `tasklist /v` 派生スクリプト） | `<ケース番号>-mem.csv` |

### 4-2. ベースライン (B0) の測定（必須）

A1 を実行する直前に、起動から **+5 秒間** の `tao` / `wry` WARN 件数をカウントし `B0` として記録する（A1 の判定にこの値を使う）。以降のケースは **観測値 - B0** で増分判定する。

### 4-3. 用語表

| 用語 | 定義 |
|---|---|
| WARN | Rust ターミナルで `WARN` レベルかつ source が `tao::*` または `wry::*` のログ行 |
| ERROR | 同上で `ERROR` レベル |
| ❌ | 期待結果のいずれかを満たさない、または console に Uncaught が 1 件以上 |
| N/A | §5-0-A の事前 grep で実装が無いことを確認した場合のみ。「未確認」N/A は禁止 |
| 「縮退」 | 機能が呼ばれても DOM 変化ゼロ・例外ゼロの状態 |

---

## 5. 手動チェックリスト

各項目「操作 → 期待結果 → ログ確認」の三点セット。チェックは ✅/❌/N/A で記入。

### §5-0. 実行順序と依存

| 順 | グループ | 前提 | 並列可否 |
|---|---|---|---|
| 1 | A 起動 / ファイル開閉 | 3-0 ゲート通過 | 不可（最初に実行） |
| 2 | B ページめくり | A2 ✅ | A と直列 |
| 3 | C ズーム | A2 ✅ | B と直列推奨 |
| 4 | D 検索 | A2 ✅ + §5-0-A 実装確認 | B/C と直列 |
| 5 | E 目次 / サムネ / 小口 | E1 は `with_toc.pdf` / E5 は `multipage_50p.pdf` | 直列 |
| 6 | F MD コピー / 保存 | A2 ✅ + 各種 fixture | 直列 |
| 7 | G 長時間 | F1 ✅ | 直列、最終盤 |
| 8 | H リリースビルド | `npm run tauri build` 完了 | 直列 |

### §5-0-A. 実装有無の事前確認（grep / DOM）

N/A 判定する前に **必ず** 以下のコマンドで実装の有無を確認する。grep がヒットすれば該当ケースは実装あり、`N/A` は禁止。

| ケース | 確認コマンド / 期待ヒット |
|---|---|
| A5 D&D | `rg "drop|dragover" src/app.js` → L1257-L1270 ヒット（実装済） |
| B5 キーボード | `rg "ArrowRight\|PageDown\|Home\|End" src/app.js` → L1112-L1130 ヒット（実装済） |
| C5 wheel ズーム / Shift スクロール | `rg "handleWheel\|wheel" src/app.js` → L1166-L1182 ヒット（実装済） |
| D 検索 | `rg "handleSearch" src/app.js` → L1077-L1098 ヒット（**現ページ内ハイライトのみ**実装、クロスページ遷移なし） |
| E TOC | DevTools Elements で `#toc-list` または `els.tocPanel` 存在確認 |
| E サムネ | DevTools Elements で `#thumbnails-list` 存在確認 |
| F1/F5 ステータス | `rg "テキストを抽出できませんでした" src/app.js` → L404 ヒット（実装済、`convertCurrentPdfToMarkdown` 内 L402-L406 ブロック） |
| 起動引数 PDF オープン | `rg "open-pdf" src/app.js` → L1276 ヒット（Tauri 環境のみ） |

---

### A. 起動 / ファイル開閉

| # | 操作 | 期待結果 | ログ確認 |
|---|------|----------|----------|
| A1 | アプリ起動 | Welcome 画面が表示される。ツールバーの prev/next/MDコピー/MD保存 が `disabled` | 起動から +5 秒間の `tao`/`wry` WARN 件数を **B0 として記録**。本ケースは「クラッシュなし」を判定基準とし「0 件」要求はしない |
| A2 | 「ファイルを開く」→ `test2.pdf` 選択 | 1ページ目が描画、`page-total` が正しい、ファイル名表示 | DevTools console で例外なし。WARN 増分 `(観測値 - B0)` を記録 |
| A3 | A2 直後に再度「開く」→ `test3.pdf` | 切り替わる。前ファイルの canvas が残らない、currentPage が 1 にリセット、検索ボックス・TOC 選択・zoomLevel が初期値、`state.mdAbortController` が null | A2 起点 2 秒以内の `RedrawEventsCleared` WARN が **B0 + 20 行以内**（B0 は §4-2 ベースライン）。**初回測定時は値をメモのみ**に留め、確定閾値は次ラウンドで B0 と本ケースの実測差を集めた上で固定する |
| A3-r | F1（MDコピー）押下 → 完了前に A3 を実行 | 旧 PDF の変換が abort される。新 PDF 用ステータスに上書き、検索・TOC・zoom 初期値 | console に `AbortError` が **1 件のみ**。DOM に旧ページ canvas 残らない |
| A4 | キャンセル（ダイアログ閉じる） | 状態変化なし、エラー無し | WARN 増分 0 |
| A5 | (a) ウィンドウ内の任意箇所へ `test2.pdf` をドロップ → (b) 拡張子 `.pdf` 以外をドロップ | (a) 開く処理と同等、(b) 何も起きない（silent ignore は `app.js:1266` の仕様） | WARN 増分は (a) で A2 と同等、(b) で 0 |
| A6 | `error/corrupted.pdf` を開く | エラー文言「**破損した PDF / 読み込めません**」相当を UI で表示。Welcome に復帰、クラッシュなし | console に `InvalidPDFException` 1 件、Uncaught 0 |
| A7 | `error/password.pdf` を開く | エラー文言「**パスワードで保護された PDF**」相当 (`convert.js` の `defaultLoadPdf` で PasswordException を判別) | console に `PasswordException` 1 件 |
| A8 | `error/empty.pdf`（0 バイト）を開く | エラー文言、Welcome 復帰 | Uncaught 0 |
| A9 | `error/fake.pdf`（PNG リネーム）を開く | エラー文言、Welcome 復帰 | Uncaught 0 |

### B. ページめくり

| # | 操作 | 期待結果 | ログ確認 |
|---|------|----------|----------|
| B1 | 「次へ」ボタン連打（10 回） | 連打分すべて反映、最終ページで disabled | `tao` WARN 件数を **クリックごとに記録**。10 クリック合計の増分を §8 に記録（次/前/MD/save の比較ベース） |
| B2 | 「前へ」ボタン連打 | 1 ページで止まる | 同上 |
| B3 | `page-input` に直接入力（例: 25）→ Enter | 25 ページにジャンプ | WARN 増分記録 |
| B4 | `page-input` に異常値入力サブケース: `0` / `-1` / `9999` / `1.5` / `Infinity` / `NaN` / `１`（全角） / 空 Enter / スペース / ペースト `1 2` | **全てクランプ or 無視**、クラッシュしない | console に Uncaught **無し** |
| B5 | キーボード `→` / `←` / PageDown / PageUp / Home / End | すべて期待通り（next/prev/last/first） | WARN 増分 |
| B6 | レンダ中に高速連打（state.rendering ガード確認） | キューイングされ最後の要求のみ確定描画 | 二重描画の WARN 無し |

### C. ズーム / フィット / ホイール

| # | 操作 | 期待結果 | ログ確認 |
|---|------|----------|----------|
| C1 | 「拡大」5 連打 | `zoom-level` 増加、canvas 拡大 | WARN 増分を記録 |
| C2 | 「縮小」5 連打 | 減少、最低値で止まる | 同上 |
| C3 | 「幅に合わせる」 | ビューポート幅にフィット | 同上 |
| C4 | ウィンドウリサイズ後に C3 | 新しい幅で再フィット | リサイズ中の `RedrawEventsCleared` 増分を記録 |
| C5 | (a) `Ctrl/Cmd+ホイール` でズーム、(b) `Shift+ホイール` で前後ページ送り | (a) 連続ズーム動作、(b) 1 tick で 1 ページ送り | フレーム落ち無し |

### D. 検索（フェーズ1 では現ページ内ハイライトのみ）

| # | 操作 | 期待結果 |
|---|------|----------|
| D1 | 検索ボックスに既知の単語入力 | **現在ページ内** の `#text-layer` 内 `span` にハイライト付与（`src/app.js:1077-1098`）。クロスページ遷移・件数表示・次/前送りは仕様外（フェーズ後送り）|
| D2 | ヒットなしの単語 | クラッシュしない（ゼロ件 UI は未実装、ステータス変化無しで OK） |
| D3 | 検索結果からのページ遷移後 B1 を再実行 | ページめくりが正常に継続 |

### E. 目次 / サムネイル / 本の小口

| # | 操作 | 期待結果 |
|---|------|----------|
| E1 | `with_toc.pdf` を開いて「目次」ボタン | サイドバーに TOC リスト |
| E2 | TOC エントリクリック | 該当ページへジャンプ |
| E3 | 「サムネイル」タブ切替 | 全ページのサムネイル生成 |
| E4 | サムネイルクリック | 該当ページへジャンプ |
| E5 | `multipage_50p.pdf` で `book-depth-wrapper` の小口（edge）描画 | edge 本数 = `calcEdgeCount(totalPages)`（`src/bookEdge.js`、`EDGE_INTERVAL=5`、`WRAP_NUM=50`）。事前準備として `bookEdge.js` を読み実装値を §8 テンプレへ記入 |
| E6 | 1 ページのみの PDF | 小口描画が縮退（`calcEdgeCount` 戻り値 0、edge 0 本）、警告なし |

### F. Markdown コピー / 保存（フェーズ1 新機能）

| # | 操作 | 期待結果 | ログ確認 |
|---|------|----------|----------|
| F1 | `test2.pdf` を開く → 「MDコピー」 | クリップボードに Markdown が入る、ステータスバーに完了文言 | **報告済み tao WARN を再現するか確認**。再現するなら回数（クリック 1 回での増分）を記録 |
| F1-cb | F1 完了後 DevTools Console で `await navigator.clipboard.readText()` を実行 | 文字数 > 0、`# ` を含む | — |
| F1-deny | DevTools Console で `navigator.clipboard.writeText = () => Promise.reject(new DOMException('blocked','NotAllowedError'))` を設定 → F1 | ステータスバーに「エラー: …」相当の **明示文言**。silent success にならない | console に NotAllowedError 1 件 |
| F2 | F1 実施後、エディタへペースト | 検証 (VS Code 等で): (a) `Ctrl+F` で `^# ` 正規表現検索 → ヒット ≥ 1 / (b) 連続空行で段落区切り / (c) `^\[.+\]\(https?://` でリンク 1 件以上（リンクは `with_links.pdf` 等で確認）| — |
| F2-uni | `unicode.pdf` を開いて F1（MDコピー）→ ペースト | (d) **Unicode 保持**: `𠮷` (U+20BB7、サロゲートペア `0xD842 0xDFB7`) が文字化け無く保持される（VS Code 上で 1 グリフ表示）/ (e) **RTL**: アラビア文字列が原文と同じ論理順で出力（双方向制御コードに依存しない単純抽出で OK）/ (f) **縦書き**: `vertical-rl` 段落が論理順 (上→下、右→左) で抽出される。いずれか欠けたら ❌ | — |
| F3 | 「MD保存」→ ダイアログ → `$DOCUMENT/test.md` で保存 | `.md` ファイルが作られ、F2 と同等の内容 | dialog/fs エラーなし |
| F3-overwrite | 既存 `.md` 上書き保存 | 上書き成功、サイズ更新 | エラーなし |
| F3-ext | 拡張子 `.txt` で保存ダイアログ確定 | **拒否**（capabilities `fs:allow-write-text-file` の allow が `**/*.md` 限定） | console にエラー or UI 通知 |
| F3-home | `$HOME` 直下（capabilities 許可外パス）で保存 | **拒否** | console にエラー or UI 通知 |
| F4 | 保存ダイアログをキャンセル | エラー無し、状態不変 | WARN 増分 0 |
| F5 | `scanned_image_only.pdf`（テキスト層なし）で MDコピー | 全 AND を満たす: (a) `await navigator.clipboard.readText()` が空 or プレースホルダ / (b) ステータスバーに「テキストを抽出できませんでした」を含む文言が **3 秒以上表示** / (c) クラッシュしない。いずれか欠けたら ❌ | console に Uncaught 0 |
| F6 | `multipage_50p.pdf` で MDコピー | 数秒で完了、UI フリーズせず | メモリ増分（タスクマネージャ「アプリ全体合計」、§4 の手順で取得）が **3 回計測の最大値で +200MB 以下を必須** |
| F6-abort | F6 変換中に A3（別 PDF を開く）を実行 | 旧変換が abort、新 PDF が描画 | console に AbortError 1 件 |
| F7 | F1 → ページ遷移 → F1 再実行 | **同一 PDF なら 2 回とも同一の MD** が出る（ページ遷移で抽出対象が変わらない） | — |
| F8 | `with_links.pdf` で MDコピー サブケース: (a) 外部 http(s) / (b) 内部 anchor / (c) `mailto:` / (d) `javascript:` / (e) `data:` | (a)(b)(c) は `[text](url)` 形式で出力（`mailto:` も `sanitizeUrl` の許可対象なら）、(d)(e) は `sanitizeUrl` が拒否しテキストのみ残る | — |
| F8-evil | `with_links_evil.pdf` で MDコピー | `javascript:` / `data:` / `vbscript:` が **MD 出力に現れない**（テキストのみ） | — |
| F9 | `partial_broken.pdf` で MDコピー | 完了文言にサフィックス「（N ページ抽出失敗: 3, 7, 12）」が付加（最大 5 ページ + `...`、`mdResultSuffix` = `src/app.js:430` 参照、`convertCurrentPdfToMarkdown` の `failedPages` は L380-L427） | console に該当ページの error 1 件ずつ |
| ~~F-disp~~ | **§3-2 (半自動 E2E) / §7 (自動化候補) へ移動**。dispatcher の `format not supported` reject は `tests/markdown/convert.test.js` の vitest 単体テストで担保済（手動からは外す）。UI 経由ではこの分岐に到達不可（DnD は `.pdf` のみ受理 / `app.js:1266`） | — |

#### F1 切り分け手順（WARN 再現時、順序固定）

> **不可侵**: コード書き換えを伴う切り分けは隔離ブランチ (`git switch -c manual-test/f1-clipboard-probe` → 実験 → `git switch -` → `git branch -D manual-test/f1-clipboard-probe` → `git status` クリーン確認) で行う。本命は **DevTools Console からのモンキーパッチ** で git 汚染ゼロ。

1. **(0) 起動直後 0 件再確認**: B0 を再測定。ベースラインがブレていないか確認。
2. **(1) B1 / C1 で同 WARN 数比較**: 既存 UI 操作でも同 WARN が出るか。出るなら MD 起因ではなく webview 全体の既存挙動。
3. **(2) F3 比較（IPC 起因か）**: F3 でも同じ WARN が出るかを比較。
4. **(3) clipboard 切り分け（非破壊モンキーパッチ）**: DevTools Console で次を実行 → F1 押下:
   ```js
   navigator.clipboard.writeText = ((orig) => async (s) => {
     console.log('[probe] md len=', s.length);
   })(navigator.clipboard.writeText);
   ```
   WARN が消えれば clipboard API がトリガ。git 汚染ゼロ。
5. **(4) PDF.js worker 切替（実験版、optional）**: `convert.js` の `defaultLoadPdf` で `disableWorker: true` を一時的に渡す実験。隔離ブランチ必須。露出 API が無ければ skip。
6. **(5) 結論記録**: `markitdown-integration.md` §5 リスク表に追記、ないし wry/tao の既知 issue 参照を残す。

### G. 長時間 / 連続操作（軽負荷ストレス）

| # | 操作 | 期待結果 |
|---|------|----------|
| G1 | **5 周（1周 60 秒）固定順序**: 次へ×3 → 拡大×2 → MDコピー×1 → 縮小×2 → 前へ×3 → 別 PDF（test3.pdf）→ 元 PDF（test2.pdf）。計 5 分 | クラッシュ無し。M0=開始 RSS / M3=3 分時点 / M5=終了時を記録し、`(M5-M0) > 1.5 × (M3-M0)` なら ❌（後半加速＝リーク疑い） |
| G2 | G1 中の `tao` WARN 件数 / 分 を記録 | 操作回数に比例する程度（B1 / F1 単発の増分 × 周回数 ± 20% 以内）、急増しない |
| G3 | 異なる PDF を 5 連続で開閉 | タスクマネージャ RSS が 5 連続開閉前後で **+50MB 以下**。詳細な detached canvas 検証は §7 自動化候補へ |

### H. リリースビルド差分

| # | 操作 | 期待結果 |
|---|------|----------|
| H1 | `npm run tauri build` で NSIS インストーラ作成 → ファイルサイズ計測 | 事前にフェーズ1 着地直前 commit の NSIS サイズを `B_size` として §8 に記録。本ビルドが **`B_size + 1MB` 以内** |
| H2 | インストール版で §5-A〜F の代表 1 ケース（A2, B1, C1, D1, F1, F3）を再実行 | dev と同じ結果 |
| H3 | capabilities 検証サブケース: (a) `$DOCUMENT/test.md` で保存成功 / (b) `$HOME/test.md` で **拒否** / (c) `$DOCUMENT/test.txt` で **拒否** | (a) 成功、(b)(c) 拒否 |
| H3-x | DevTools Console で `await window.__TAURI__.fs.writeTextFile('C:/Windows/probe.md', 'x')` 相当を試行（API 露出名は実装と整合させ要確認、無ければ **skip 可**）| 拒否される（ACL or capabilities） |

## 6. 合否基準

- **必須**: §5-A〜F のうち ❌ がゼロ（F5 の "明示エラー表示" を含む）。
- **必須**: F1 の tao WARN について **原因切り分け結果が記録されている**。修正可能なら修正、wry/tao 由来で害が無いと判断したなら `markitdown-integration.md` リスク表に追記して許容。
- **推奨**: §5-G/H に ❌ ゼロ。
- **N/A 禁止**: §5-0-A の grep で実装ありが確認できる項目（A5/B5/C5/D/F1/F5）は N/A 不可。実装が無いことが grep で確認できた項目のみ N/A 可、その旨を §5-0-A の確認結果と共に記録。
- **❌ ≥ 1 のケース** は §7 自動化候補に追加し issue 化、3 ヶ月以内に E2E 化。

## 7. 後続の自動化候補（任意・別 RFC）

手動運用の負担が大きくなった時点で以下を E2E 化:

- A2 / A3 / A6〜A9（ファイル開閉 / エラー経路）
- B1 / B3 / B4（ページ遷移 / OOB 入力）
- F1 / F3 / F5 / F8 / F9（MDコピー / 保存 / 空 / リンク / 部分失敗）— Tauri 側のクリップボード/fs を Playwright で fixture 検証
- F-disp（dispatcher の `format not supported` reject）— vitest `tests/markdown/convert.test.js` で担保済、E2E では UI 露出経路の不存在を回帰確認するだけで OK
- G3（リソース解放）— DevTools Protocol 経由のヒープスナップショット比較
- M1（detached canvas 厳密判定）

実装時は `tests/e2e/` を新設し、`@tauri-apps/cli` の `tauri dev --no-watch` をジョブ起動 → Playwright で接続する構成。CI は `workflow_dispatch` 手動起動のみ（フェーズ2 の `MARKITDOWN_E2E` ジョブと同じ思想）。

## 8. 実施記録テンプレート

```markdown
## 実施記録 (YYYY-MM-DD, 実施者: <name>)

- ビルド: <commit hash> / dev / release
- OS: Windows 11 <build>
- 前提ゲート:
  - npm run test: <X 件 / 緑 or 赤>
  - coverage: lines=__% / functions=__% / branches=__% / statements=__%
  - フィクスチャ確認: OK / NG (<missing>)
- 事前定数:
  - B0 (起動 +5 秒 WARN): __ 件
  - B_size (NSIS baseline): __ MB
  - EDGE_INTERVAL=5, WRAP_NUM=50, calcEdgeCount(50)=__ , calcEdgeCount(100)=__
    - 期待値: **calcEdgeCount(50)=49 / calcEdgeCount(100)=49**（同値）。`src/bookEdge.js:19-23` の式 `Math.max(0, floor(totalPages / Math.max(1, ceil(totalPages/WRAP_NUM))) - 1)` により、totalPages=50 → number=1 で floor(50/1)-1=49、totalPages=100 → number=2 で floor(100/2)-1=49。`number` の段階効果で 100 ページでも 50 ページと同数となる挙動を実装で確認可能。
- 結果サマリ（縦並び、各ケース ✅/❌/N/A）:
  - A: A1=__ A2=__ A3=__ A3-r=__ A4=__ A5=__ A6=__ A7=__ A8=__ A9=__
  - B: B1=__ B2=__ B3=__ B4=__ B5=__ B6=__
  - C: C1=__ C2=__ C3=__ C4=__ C5=__
  - D: D1=__ D2=__ D3=__
  - E: E1=__ E2=__ E3=__ E4=__ E5=__ E6=__
  - F: F1=__ F1-cb=__ F1-deny=__ F2=__ F2-uni=__ F3=__ F3-overwrite=__ F3-ext=__ F3-home=__ F4=__ F5=__ F6=__ F6-abort=__ F7=__ F8=__ F8-evil=__ F9=__
  - (F-disp は §3-2/§7 へ移動。手動チェックでは記録不要)
  - G: G1=__ G2=__ G3=__
  - H: H1=__ H2=__ H3=__ H3-x=__
- tao WARN 集計（`観測値 - B0` 形式）:
  - 起動直後: B0=__
  - B1 (10連打): __ 件 / 操作
  - C1 (5連打): __ 件
  - F1 (MDコピー1回): __ 件
  - F3 (MD保存1回): __ 件
  - G1 (5周): __ 件 / 5 分
- メモリ計測:
  - F6: M_pre=__ MB / M_post(最大)=__ MB / 増分=__ MB （閾値 +200MB）
  - G1: M0=__ M3=__ M5=__ → (M5-M0)/(M3-M0)=__ （閾値 1.5）
  - G3: 5 連続開閉 前=__ 後=__ 増分=__ MB （閾値 +50MB）
- ログアーカイブ: docs/plan/manual-test-2026-04-26-logs/
- ❌ / 未解決:
  - <ケース番号>: 現象 / 再現手順 / ログ抜粋 / 原因仮説
- 追加チケット: <issue or PR link>
```

---

## レビュー反映 (2026-04-26, ラウンド R1)

R1 集約 (CRITICAL 6 / HIGH 14 / MEDIUM 13 = 計 33 件) を全件反映。

### CRITICAL (6)

| id | サマリ | 状態 |
|---|---|---|
| C1 | フィクスチャ作成手順を §2-A の表で全件明記、`scripts/check-manual-fixtures.js` 案を §2-A-1 に記載、§3-0 ゲート化 | DONE |
| C2 | D1/D2 の期待結果を `app.js:1077-1098` の実装（現ページ内ハイライトのみ）に整合。クロスページ遷移はフェーズ後送り旨明示 | DONE |
| C3 | F1/F5 ステータス検証を AND 条件 (a)(b)(c) に再定義、`navigator.clipboard.readText()` での文字数確認手順を F1-cb として追加 | DONE |
| C4 | A6/A7/A8/A9 を新設（corrupted / password / empty / fake.pdf）、§2-A の error/* fixture 作成手順記載 | DONE |
| C5 | F1 切り分け 1 を「DevTools Console モンキーパッチ」に変更（git 汚染ゼロ）、コード改変が必要な実験は隔離ブランチ手順を必須化 | DONE |
| C6 | §4-0 RUST_LOG 起動 / §4-1 観察手順詳細表 / プロセス名特定 (productName=PDF Viewer + msedgewebview2.exe) を新設 | DONE |

### HIGH (14)

| id | サマリ | 状態 |
|---|---|---|
| H1 | §3-0 / §3-1 で `npm run test` 内訳と件数（実測 89 件、収束時 103）を記載、coverage gate を §3-0 必須項目化 | DONE |
| H2 | A5/B5/C5 を実装根拠付き固定（D&D = `app.js:1257-1270`、キーボード = L1112-1130、wheel = L1166-1182）。N/A 抜け道削除 | DONE |
| H3 | §5-0-A「実装有無の事前確認」を新設、grep / DOM コマンドを表で提示 | DONE |
| H4 | H3 を (a)(b)(c) サブケースに分割、H3-x で `__TAURI__.fs.writeTextFile` 試行（API 露出無ければ skip 可）を追加 | DONE |
| H5 | §4-0 で `RUST_LOG=warn` 起動を必須化、A1 のベースライン (B0) ロジックを §4-2 で定義し「0 件断定」を撤回 | DONE |
| H6 | A3「20 行未満」/ F6「+200MB 必須」/ G1「(M5-M0)>1.5×(M3-M0)」/ G3「+50MB」と数値化、§4-3 用語表を新設 | DONE |
| H7 | B4 に `-1`/`1.5`/`Infinity`/`NaN`/`１`/空 Enter/スペース/ペースト `1 2` を追加 | DONE |
| H8 | A3-r「F1 完了前に A3」を追加、AbortError 1 件まで許容、UI/state リセットの全項目検証 | DONE |
| H9 | F1-deny / F3-ext / F3-home サブケースを追加、capabilities `**/*.md` 限定を逆手に取った拒否経路を検証 | DONE |
| H10 | `unicode.pdf` fixture を §2-A に追加、F2 検証手順に Unicode/RTL/縦書き を組み込み（H10 は F2/F8 で吸収） | DONE |
| H11 | F1 切り分け順序を (0)(1)(2)(3)(4)(5) に再編、(1) を「B1/C1 で同 WARN 比較」最優先に | DONE |
| H12 | §2 / §4-1 / §8 にログ保存先 `docs/plan/manual-test-2026-04-26-logs/` と命名規則 `<ケース番号>-tao.log` 等を明記 | DONE |
| H13 | §5-0「実行順序と依存」表を新設、A→B→C→D→E→F→G→H + 並列可否 | DONE |
| H14 | §8 結果サマリを縦並び `A: A1=__ A2=__ ...` に変更、G1 を「5 周固定順序 1 周 60 秒」に固定化 | DONE |

### MEDIUM (13)

| id | サマリ | 状態 |
|---|---|---|
| M1 | G3 を「タスクマネージャ RSS 5 連続前後 +50MB 以下」に簡素化、DevTools Memory snapshot 詳細は §7 へ移動 | DONE |
| M2 | F8 を 5 サブケース (http/anchor/mailto/javascript/data) + F8-evil で `with_links_evil.pdf`、`sanitizeUrl` 経由で危険スキーム除外を確認 | DONE |
| M3 | F3-overwrite / F3-ext / F3-home を追加 | DONE |
| M4 | F6 のメモリ計測対象を「タスクマネージャ アプリ全体合計」と明示、F6-abort で旧変換 AbortError を確認 | DONE |
| M5 | F9 を新設、`partial_broken.pdf` 作成手順を §2-A に追加、ステータス文言「N ページ抽出失敗: 3, 7, 12」を `app.js:407` 参照付きで明記（R2 で `app.js:430 / mdResultSuffix` に行番号修正） | DONE |
| M6 | §6 末尾に「❌ ≥ 1 のケースは §7 候補に追加し 3 ヶ月以内に E2E 化」を追加 | DONE |
| M7 | F7 を「同一 PDF なら 2 回とも同一の MD」に書き換え、キャッシュ表現排除 | DONE |
| M8 | E5 を `calcEdgeCount(totalPages)` 実装値に紐付け、`bookEdge.js` の `EDGE_INTERVAL=5` / `WRAP_NUM=50` を §8 テンプレに記録欄として追加 | DONE |
| M9 | H1 を「フェーズ1 直前 commit の NSIS サイズを B_size、本ビルドが B_size + 1MB 以内」に変更、§8 に B_size 欄追加 | DONE |
| M10 | F2 検証を VS Code `Ctrl+F` 正規表現 (`^# ` / `^\[.+\]\(https?://`) で具体化 | DONE |
| M11 | F1 切り分け 2 を「optional・露出 API 無ければ skip」と明記、最小スニペット併記 | DONE |
| M12 | F-disp で dispatcher 例外（`fake.docx` reject）テストを追加、UI 経由で到達不可（DnD は `.pdf` 限定 / `app.js:1266`）を併記 | DONE |
| M13 | §3-0 ゲートに「`npm run test` が 1 件でも失敗していたら本計画は中断」と明記 | DONE |

### 修正中に発覚した設計判断 / 計画書更新の根拠

- `src-tauri/capabilities/default.json` の `fs:allow-write-text-file` は `$DOCUMENT/$DESKTOP/$DOWNLOAD` の `**/*.md` 限定（`fs:default` は R4 で削除済）。F3-ext / F3-home の拒否は capabilities の allow が path/extension の AND で機能するため確実。
- `tauri.conf.json` の `productName` は `PDF Viewer`。リリース時のプロセス名特定は §4 の本文に記載済。
- `src/bookEdge.js` の定数 (`EDGE_INTERVAL=5` / `WRAP_NUM=50` / `HOVER_MULT=4` / `HIGHLIGHT_MULT=8`) は実装に基づき §8 テンプレに記録欄を設けた。実施者は `multipage_50p.pdf` で `calcEdgeCount(50) = floor(50/1) - 1 = 49` 等を確認できる。
- `src/app.js:1077-1098` の `handleSearch` は **現ページ内 textLayer span** のみハイライト。クロスページ遷移／件数表示／次/前送りは未実装。D1 の期待を仕様に整合させた。
- `src/app.js:380-427` の `convertCurrentPdfToMarkdown` は race ガード (`pdfAtStart`/`controller`) と `failedPages`（最大 10 収集）を持つ。F6-abort / F9 / A3-r はこの実装に整合。

### 新たな見逃しパターン候補（次回 MISSES.md 追記候補）

- **手動テスト計画でフィクスチャ作成手順を「既存ファイルから派生」と一行で書くと、実施者が再現できず計画が止まる**。fixture 作成は **コマンドレベル** で書く（`qpdf --pages`、`magick`、`head -c` 等）。
- **`tao` WARN「0 件」を期待結果に書くのは絶対避ける**。ベースライン B0 を測って増分判定する設計に最初からしておく。
- **N/A の抜け道**: 「実装されていれば」「あれば」のような条件付き記述は実施者が「無い」と書いて消化したつもりになる。必ず §5-0-A 相当の grep 確認手順を入れて N/A を「不存在の確認」に格上げする。
- **コード書き換えを伴う切り分け手順**を計画書に書くと、実施者が `git status` を汚す。DevTools Console モンキーパッチを **本命** に置く。

### 持ち越し（LOW のみ、なし）

R1 集約は CRITICAL+HIGH+MEDIUM 計 33 件で構成され、本ラウンドで全件 DONE。LOW 持ち越しは無し。

### 反映前後の行数差分

- 反映前 (R0 着地直後): 177 行
- R1 反映後 (R2 開始時の実測): **451 行**（+274 行、初稿で「約 510 行 / +333 行」と概算記載していたが、R2 の冒頭で実測し補正）
- R2 反映後の値は本ファイル末尾「### R2 反映」ブロック内に再掲。
- 主な増加: §0 / §2-A / §2-A-1 / §3-0 / §4-0 / §4-1 / §4-2 / §4-3 / §5-0 / §5-0-A / §5-A の A3-r〜A9 / §5-F の F1-cb 〜 F-disp / §6 N/A 禁止条項 / §8 縦並びテンプレ + B_size + EDGE_INTERVAL 欄 / 本反映ブロック

---

## レビュー反映 (2026-04-26, ラウンド R2)

R2 集約 (HIGH 5 / MEDIUM 7 = 計 12 件) を全件反映。R1 で `DONE` としていた一部項目に対する精査由来の修正。

### HIGH (5)

| id | サマリ | 状態 |
|---|---|---|
| H-N1 | §3-0 の「103 テスト緑」硬直記述を削除し「§3-1 表合計の実測値」に書き換え。§3-1 表の合計行も「実測 89」を主軸に整え `npx vitest run` 出力での再確認手順を併記 | DONE |
| H-N2 | `scripts/check-manual-fixtures.js` を **実ファイルとして作成**（依存ゼロ、対象 11 ファイル: with_toc / multipage_50p / scanned_image_only / with_links / with_links_evil / unicode / partial_broken / error/{corrupted,empty,fake,password}）。§2-A-1 を「案」から「実ファイル」記述に更新 | DONE |
| H-N3 | §2-A の corrupted / empty / fake 作成手順に **PowerShell サブ表記** を追記（`[IO.File]::WriteAllBytes` / `New-Item -ItemType File` / `Copy-Item`）。既存 unix 例も維持 | DONE |
| H-N4 | `with_toc.pdf` の qpdf JSON 構文（実在しない `qpdf-v2.outlines`）を削除。LibreOffice (見出しスタイル + Export as PDF + Export bookmarks ON) を本命、`pikepdf.open_outline()` の最小スクリプトを代替として併記 | DONE |
| H-N5 | `partial_broken.pdf` 作成手順を **pikepdf 最小スクリプト**（page index 2/6/11 の `/Contents` を空 stream に差し替え）に格上げ。物理破壊コマンドは「代替」として最小限残置 | DONE |

### MEDIUM (7)

| id | サマリ | 状態 |
|---|---|---|
| M-N1 | F9 と「修正中に発覚した設計判断」内の `app.js:407` 参照を **実測した `app.js:430 / mdResultSuffix`** に補正。M5 の R1 行にも追記。本体定義は L380-L427 / suffix は L430 で確認 | DONE |
| M-N2 | §5-0-A の "テキストを抽出できませんでした" の参照を `app.js:402-L406` から **`app.js:L404`（ブロック L402-L406）** に補正 | DONE |
| M-N3 | F2 行に `F2-uni` サブケースを新設し、`unicode.pdf` で (d) `𠮷`(U+20BB7) サロゲートペア保持 / (e) アラビア論理順 / (f) 縦書き論理順 を検証。§8 結果サマリにも `F2-uni=__` を追加 | DONE |
| M-N4 | F-disp を §5-F 手動チェックリストから外し打ち消し線で「§3-2/§7 へ移動・vitest `tests/markdown/convert.test.js` で担保済」を明示。§7 自動化候補にも追加。§8 サマリから `F-disp=__` 削除 | DONE |
| M-N5 | §8 テンプレ EDGE_INTERVAL 行直下に **期待値 calcEdgeCount(50)=49 / calcEdgeCount(100)=49** と算式根拠 (`Math.ceil(totalPages/WRAP_NUM)` で number=2) を注記。`bookEdge.js:19-23` 参照付き | DONE |
| M-N6 | R1 反映ブロックの行数記述「約 510 行 / +333 行」を **R2 開始時実測 451 行 / +274 行** に補正、R2 末尾で再度実測値を記録 | DONE |
| M-N7 | A3 の「2 秒以内 20 行未満」を **「B0 + 20 行以内、初回測定時はメモのみ・閾値は次ラウンドで確定」** に書き換え（B0 は §4-2 連動） | DONE |

### R1 ⚠ PARTIAL の 7 件 再記録

R1 では全件 DONE と記載していたが、R2 精査で以下 7 件は実装と齟齬があり PARTIAL 相当と再評価。今回 R2 で全て解消。

| 元 R1 id | 齟齬の内容 | R2 解消 |
|---|---|---|
| C1 | `scripts/check-manual-fixtures.js` を「案」表記に留めて未作成 | H-N2 で実ファイル作成 |
| C4 | error fixture 作成手順が unix 専用（実施 OS は Windows 11） | H-N3 で PowerShell 併記 |
| H10 | F2 期待結果に Unicode/RTL/縦書きの観察項目が含まれていなかった | M-N3 で F2-uni 新設 |
| H1 | §3-0 と §3-1 で件数（103 vs 89）が矛盾 | H-N1 で 89 一本化 |
| M5 | F9 の `mdResultSuffix` 参照行が `app.js:407`（実際は L430） | M-N1 で L430 に補正 |
| M8 | §8 テンプレに calcEdgeCount 期待値の記載なし（実施者が計算する負荷） | M-N5 で 49/49 を併記 |
| M12 | F-disp が UI 経由で実行不能なのに手動チェックリスト本体に居座っていた | M-N4 で §3-2/§7 へ移動 |

### 修正中に発覚した追加事項（次回 MISSES.md 候補）

- **行番号参照は冷えた実施者が grep で検証する。書く側も実装と diff 取らずに数字を写経すると齟齬の温床になる**。R1→R2 で `app.js:407 → 430` / `L402-L406 → L404` の 2 件発生。次回はレビュー時に「行番号が出てきた箇所すべて grep する」チェックリスト項目を入れる。
- **`qpdf` の JSON 構造はバージョンで異形がある**。`qpdf --replace-input --json='...outlines...'` のような構文は qpdf v11 に存在しない。フィクスチャ作成手順は実施前にコマンドラインで素振りすること。
- **OS-specific シェル前提は計画書執筆時に最も忘れやすい**。Windows 11 が一次ターゲットと §2 に書いてあるのに本文の作成手順が unix 一辺倒だった。`os: windows-11` を §2 に書いた以上、コマンド例は PowerShell 併記をデフォルトにする。
- **`number = ceil(totalPages/WRAP_NUM)` のような段階関数は値が直感に反する**。`calcEdgeCount(50)=49`（最大値）/ `calcEdgeCount(100)=49`（同値）という挙動は実施者が事前に把握していないと「100 ページで 99 本」を期待してしまう。テンプレに期待値直書きが安全。

### 反映前後の行数差分（R2）

- R2 反映前: 451 行
- R2 反映後: **497 行**（+46 行、本 R2 ブロック + 各種行内拡張分）
- 内訳の主な増加: §2-A の corrupted/empty/fake/with_toc/partial_broken の手順拡張 / F2-uni 新設 / F-disp 移動注記 / §8 calcEdgeCount 期待値 / 本 R2 反映ブロック
