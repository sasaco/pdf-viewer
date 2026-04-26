# review-fixes 2026-04-26 (markitdown-integration.md)

PlanLoop オーケストレーションによる計画書整合修正のラウンド別ログ。

## ラウンド 1 (2026-04-26)

### 統一決定（全実装者共通）

1. 「追加ランタイム不要」原則はフェーズ2 着手をもって更新する（§2 方針更新ブロック）。
2. extras 統一: `[docx,pptx,xlsx,outlook,xls]`。HTML / PNG は markitdown 標準で extras 不要。
3. サイズ表記: インストーラ +約 15MB（uv 同梱）／初回起動時 ~30MB Python DL + ~50MB venv の二段定義。+20MB 表記は撤回。
4. 完了条件は曖昧語禁止。`expect(...).toContain(...)` / fixture 比較で assert 化。
5. テスト実行コマンド: フロント `npm run test`、Rust `cargo test -p app --lib markitdown::<mod>`、E2E `MARKITDOWN_E2E=1 npm run test -- markitdown.e2e`。
6. Tauri Event は `markitdown://bootstrap-progress {stage,message,progress?}` と `markitdown://ready {}` の 2 本のみ。
7. `convert_to_markdown` は canonicalize + 拡張子 allowlist + dialog open() 経由限定。
8. 未決 #2 / #5 はフェーズ2 着手前ゲートに昇格（フェーズ1 純JS は影響を受けない）。
9. marimo 流用元は `src-tauri/src/paths.rs`（`environment/` 配下ではない）と明示。
10. Cargo.toml の `log` は既存。`anyhow` のみ追加。
11. capabilities は既存 `dialog:default` + `dialog:allow-open` + `fs:default` + `fs:allow-read-file` のみ。`dialog:allow-save` と `fs:allow-write-text-file` をフェーズ1 で追加。
12. `convert.js` interface はフェーズ1 で確定（PDF 分岐のみ実装）。フェーズ2 で sidecar 分岐追加。
13. PDF.js 5.x API の事前 spike（T0）をフェーズ1 タスクに追加。
14. CI: `.github/workflows/test.yml` を新設（PR で `npm run test` + `cargo test --lib`）。E2E は `workflow_dispatch`。
15. macOS/Linux 工数を分離（macOS +3〜4日 署名/notarization、Linux +1〜2日）。

### Findings 一覧

| ID | 観点 | 重要度 | 対象ファイル:箇所 | 修正概要 |
|----|------|-------|------------------|----------|
| AB-H1 | A | HIGH | markitdown-integration.md §2 (L20,23,64) | 「追加ランタイム不要」とフェーズ2 Python 導入の整合矛盾。§2 に方針更新宣言ブロックとフェーズ2 着手前ゲートを追加 |
| AB-H2 | B | HIGH | §4-2-2 (L109) | marimo `paths.rs` の流用元を `src-tauri/src/paths.rs` と明示（`environment/` 配下ではない） |
| C-H1 | C | HIGH | §4 (L83,148) | 完了条件「目視確認可能」「主要5形式成功」を assert 化（toContain / fixture 比較） |
| C-H2 | C | HIGH | §4-1 (L72) | PDF.js 5.x API 確認の T0 spike タスクを追加 |
| C-H3 | C | HIGH | §4-2-3 (L125) | スプラッシュ Event 名と payload schema を統一定義（`bootstrap-progress` / `ready`） |
| C-H4 | C | HIGH | §4-2-4 (L130) | `convert_to_markdown` パストラバーサル検証（canonicalize + allowlist + dialog 限定） |
| C-H5 | C | HIGH | §8 (L201-207) | 未決 #2 / #5 をフェーズ2 着手前ゲートに昇格 |
| D-H1 | D | HIGH | §4 (L77-79,144-146) | テスト関数名・入力・期待結果・実行コマンドを各テスト項に列挙 |
| D-H3 | D | HIGH | §4-2-7 (L144-146) | `MARKITDOWN_E2E=1` skipIf 位置と `.github/workflows/test.yml` 新設を明記 |
| D-H4 | D | HIGH | §4-2-7 (L146) | Rust テスト関数名・モジュールパス・`cargo test` コマンドを列挙 |
| AB-M1 | A | MEDIUM | §4 / §5 / §8 | extras 表記揺れを §3-2 末尾の対応表に統合 |
| AB-M2 | A | MEDIUM | §5 / §4-2-7 | バンドルサイズ表記をインストーラ vs 初回 DL に分離 |
| AB-M3 | B | MEDIUM | §6 (L177) | 既存 `log` を「追加」から削除、`anyhow` のみ |
| AB-M4 | A | MEDIUM | §4-1 / §6 | capabilities を「既存のまま」から「`dialog:allow-save` / `fs:allow-write-text-file` 追加」に統一 |
| AB-M5 | A | MEDIUM | §4-1 / §6 | フェーズ1 で `convert.js` を新設すると明記し、抽象化レイヤー問題と同時解消 |
| C-M1 | C | MEDIUM | §4-1 / §5 | フェーズ1 で `convert.js` interface を先に確定（フェーズ2 抽象化のための足場） |
| C-M2 | C | MEDIUM | §4-2-3 / §5 | リトライ回数（最大2回）+ 指数バックオフ（5s/15s）+ `uv pip check` で venv 破損検知 |
| C-M3 | C | MEDIUM | §5 | バージョン比較判定ソース（pyproject vs venv）とメジャー upgrade のユーザー確認 |
| C-M4 | C | MEDIUM | §4-2-3 (L118) | `UV_PYTHON_INSTALL_DIR` / `UV_PYTHON_PREFERENCE` / `UV_PYTHON_INSTALL_MIRROR` の値・意味・適用段階を明示 |
| C-M5 | C | MEDIUM | §7 | macOS/Linux 工数を分離して再見積 |
| D-M1 | D | MEDIUM | §4-2-7 | ネガティブテストを `markitdown.negative.test.js` と Rust unit に列挙 |
| D-M2 | D | MEDIUM | §6 | `scripts/check-bundle-size.js` でインストーラサイズ baseline 比較 |
| D-M3 | D | MEDIUM | §4-2-3 / §4-2-6 | `markitdown://bootstrap-progress` 購読を `convert.js` に明記 |

### LOW（対応不要、参考）

- AB-L1: `uv pip install -r pyproject.toml` 形式に統一 → 反映済（§4-2-3）。
- AB-L2: permission 重複説明（§4-2-5 と §6） — 残置。
- C-L1: 進捗 UI のキャンセル経路 — 残置。フェーズ2 実装中に必要なら別 RFC。
- C-L2: marimo `paths.rs` 流用ライセンス表記 → §6 影響範囲チェックリストに追記済。
- D-L1: `tests/fixtures/markitdown/` 未作成 — フェーズ2 着手時に新設で良い（チェックリストに記載済）。
- D-L2: `npm run test` 明記 → 各テスト項に追記済。

### 機械検証（grep）

- `grep "log を追加" / "log[, ]*anyhow"`: 旧記述ゼロを確認。
- `grep "+20MB"`: ゼロ。
- `grep "目視"`: ゼロ。
- `grep "markitdown://"`: `bootstrap-progress` と `ready` の 2 種のみ。
- `grep "dialog:allow-save"`: §4-1 と §6 で同一文言。
- `grep "[all]"` (markitdown extras): リスク表 1 箇所のみ（OCR/音声に関する文脈で正当）。
