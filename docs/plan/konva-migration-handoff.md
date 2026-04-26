# 作業依頼：ページ厚み表現の Konva 移行（Civilinkベース）

## 依頼概要

現在の `div` ベースの DOM アプローチを破棄し、[Civilink プロジェクト](C:\Users\sasai\Downloads\civilink-frontend-release\civilink-frontend-release)で実装されているような**「高機能かつ自然に角が繋がる、Konva を用いた高度なページ厚み表現」**を `PyMuPDF` ビューアに移植してください。

## 目的・解決する課題

1. **角のシームレスな結合**: 右と上の影を別々の要素にするのではなく、背面に矩形を重ねてズラす（Civilink方式）ことで、「積み重なった本の紙」を完璧に表現する。
2. **インタラクティブなページ移動**: 影レイヤー（紙の側面）にマウスを乗せると特定のページ幅が広がり、クリックで該当ページにジャンプできるようにする。
3. **現在のページ位置の可視化**: ページをめくると背面の影の数（厚み）が視覚的に変わり、現在位置（スタック内での自分の場所）が一目でわかるようにする。
4. **ズーム・パン追従**: Konva Stage 上で描画を同期し、ズームや中ボタンドラッグのパン操作に影が正確に追従するようにする。

## 背景・設計意図（なぜ DOM や SVG ではなく Konva か）

当初はシンプルなUIの装飾として DOM の `div` や SVG の `<polygon>` が妥当と考えられていました。しかし、参考である Civilink プロジェクトの機能水準（無数の矩形を背面にズラして配置し、見えない平行四辺形でホバー判定を行って動的に厚みをアニメーションさせる等）を達成するには、以下の理由から **Konva(Canvas) による描画が不可避かつ最適** です。

1. **複雑な再描画パフォーマンス**: 何十枚もの紙の「重なり」と「動的な厚みの変化（ホバー時の拡幅）」を SVG の DOM 更新で表現すると、レイアウトシフトが発生しパフォーマンスが低下します。Konva なら Canvas 上で高速にバッチレンダリングが可能です。
2. **当たり判定の高度な計算**: L字型の角を持つ複雑な図形ではなく、「重ねた矩形」の上に「透明な判定用ポリゴン（Line）」を被せ、マウスのローカル座標から「現在何ページ目の厚みを指しているか」を逆算して描画を更新するという手法は、Canvas の座標系（Konva）だからこそ正確に制御できます。
3. **ズームとパンの完全同期**: 本の厚み（背景の矩形群）と PDF Canvas 本体のスケール・座標系をズーム操作時やドラッグパン時にズレなく確実に同期させる上で、全体を1つの Konva Stage に収める設計が最も堅牢です。

## 技術スタックと前提

- Tauri 2 + **バニラ JS（React なし）** + Vite
- PDF.js（pdfjs-dist）を用いた Canvas レンダリング
- 新規追加: **Konva** (`npm install konva`)
- 対象ファイル: `src/app.js`, `src/style.css`, `src/index.html`

## 設計仕様（Civilink 実装のバニラ JS への移植）

### 1. HTML構造の整理

`#pdf-container` 内の構造を Konva に合わせて整理します。

Konva の Stage は Canvas 要素を生成してポインターイベントを吸収するため、PDF.js のテキストレイヤー（テキスト選択用）はその上に重ねる必要があります。`pointer-events: none` を外して操作可能にするため、text-layer は Konva Stage より高い z-index に配置し、**テキスト選択に関係しない領域では `pointer-events: none` を維持**します（クリックが Konva まで届くようにするため）。

```html
<div id="pdf-container" style="position: relative;">
  <div id="konva-wrapper" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1;">
    <!-- Konva Stage がここにマウントされる -->
  </div>
  <div id="text-layer" style="position: absolute; z-index: 3; pointer-events: none;"></div>
</div>
```

### 2. Konva Stage とレイヤー構成

単一の `Layer` に描画順（z-order）を意識して追加します。

```text
Stage (画面全体サイズ)
 └── Layer
      ├── Rect × count 個（背面から前面の順、逆順で add）
      ├── Line（右側ホバー判定用・透明）
      ├── Line（上側ホバー判定用・透明）
      └── Image（PDF.js が生成した canvas を imageSource に指定）
```

### 3. 表示ロジック（厚みと矩形の生成）

#### 定数

```js
const intervalX = 5;              // 通常時: 右へのズレ幅（px）
const intervalY = -5;             // 通常時: 上へのズレ幅（px）
const HOVER_MULTIPLIER = 4;       // ホバー時は 4 倍
const HIGHLIGHT_MULTIPLIER = 8;   // 現在ページ位置は 8 倍（= page1Interval）
```

#### 背景ページ数 `count` の計算

```js
const wrapNum = 50;
const number = Math.ceil(totalPages / wrapNum);   // グループ数
const count = Math.floor(totalPages / number) - 1; // 描画する背景枚数
```

- 例: 100ページ → number=2, count=49
- 例: 300ページ → number=6, count=49

#### 各矩形の幅・高さ（状態に応じて変化）

```js
// hoveredIndex: 現在マウスが乗っている背景インデックス
// highlightedIndex: 現在表示ページのスタック内インデックス（後述）
function getRectWidths(count, hoveredIndex, highlightedIndex) {
  return Array.from({ length: count }, (_, i) => {
    if (i === highlightedIndex) return intervalX * HIGHLIGHT_MULTIPLIER; // 40
    if (i === hoveredIndex)     return intervalX * HOVER_MULTIPLIER;     // 20
    return intervalX;                                                     // 5
  });
}
// Y方向も同様（絶対値で計算し、配置時に符号を反転）
```

#### 累積座標（各矩形の左上角）

```js
function calcPositions(widths) {
  const positions = [];
  let cumulative = 0;
  for (const w of widths) {
    cumulative += w;
    positions.push(cumulative); // このインデックスの矩形の「右端」
  }
  return positions;
  // Rect の x 座標は positions[i-1]（0 の場合は 0）
}
```

`rectPositionsX[i]` は i 番目の矩形の **右端** の累積位置。矩形の `x` は `i === 0 ? 0 : rectPositionsX[i-1]` とする。

#### `highlightedIndex`（現在ページのスタック内位置）の計算

```js
function getHighlightedIndex(currentPage, totalPages, count) {
  if (totalPages <= 1) return 0;
  const relativePos = (currentPage - 1) / (totalPages - 1); // 0.0〜1.0
  return Math.min(Math.floor(relativePos * count), count - 1);
}
```

> **注意**: これは「ページ1専用のハイライト」ではなく、**現在表示しているページがスタック内のどの位置にあるか**を示します。ページをめくると `highlightedIndex` が変化し、ハイライトされる帯の位置が移動します。

### 4. インタラクション（マウスホバーとクリック）

#### 透明な平行四辺形の配置

右側・上側それぞれに、厚み全体をカバーする `Konva.Line({ closed: true, opacity: 0 })` を配置します。

```js
// 右側（X方向）の平行四辺形の頂点（renderWidth = PDF 本体の幅）
const totalOffsetX = rectPositionsX[count - 1]; // 全矩形の累積幅
const parallelogramXPoints = [
  renderWidth, 0,
  renderWidth + totalOffsetX, -totalOffsetY,   // 右上
  renderWidth + totalOffsetX, renderHeight - totalOffsetY,
  renderWidth, renderHeight,
];
```

#### ホバーインデックスの逆算

`mousemove` イベントで Konva のローカル座標を取得し、`rectPositionsX` と比較してインデックスを特定します。

```js
parallelogramX.on('mousemove', (e) => {
  const stage = e.target.getStage();
  const pos = stage.getPointerPosition();
  const transform = e.target.getAbsoluteTransform().copy().invert();
  const local = transform.point(pos);

  let hoveredIndex = -1;
  for (let i = 0; i < rectPositionsX.length; i++) {
    const startX = i === 0 ? 0 : rectPositionsX[i - 1];
    const endX = rectPositionsX[i];
    if (local.x - renderWidth >= startX && local.x - renderWidth < endX) {
      hoveredIndex = i;
      break;
    }
  }

  if (hoveredIndex !== -1) {
    setHoveredIndex(hoveredIndex);
    redraw(); // layer.batchDraw() を呼ぶ
  }
});

parallelogramX.on('mouseleave', () => {
  setHoveredIndex(-1);
  redraw();
});
```

#### クリック時のページジャンプ

ホバーインデックスから実際のページ番号への変換：

```js
function getPageForIndex(index, highlightedIndex, currentPage, totalPages, count) {
  if (index === highlightedIndex) return 1; // 最も手前 = 1ページ目に相当
  if (index < highlightedIndex) {
    // 現在ページより後ろのページ群（右奥に積まれている）
    const slots = highlightedIndex;
    const pages = totalPages - currentPage;
    const pagesPerSlot = pages / slots;
    return Math.min(currentPage + 1 + Math.floor(index * pagesPerSlot), totalPages);
  } else {
    // 現在ページより前のページ群（左手前に積まれている）
    const adjustedIndex = index - highlightedIndex - 1;
    const slots = count - highlightedIndex - 1;
    const pages = currentPage - 2;
    const pagesPerSlot = pages / slots;
    return Math.max(2 + Math.floor(adjustedIndex * pagesPerSlot), 2);
  }
}
```

> **状態変更後は必ず `layer.batchDraw()` を呼ぶ**。React のような自動再レンダリングはないため、`hoveredIndex` や `currentPage` が変わるたびに手動でまとめて再描画します。

### 5. パンとズームの同期

#### ズーム

既存のズーム変数（`currentScale` 等）が変わるタイミングで、`stage.scale()` と `stage.position()` を更新します。PDF.js 側での再レンダリングは不要です（Konva の stage scale が全子要素に適用されます）。

```js
function syncStageZoom(scale, panX, panY) {
  stage.scale({ x: scale, y: scale });
  stage.position({ x: panX, y: panY });
  stage.batchDraw();
}
```

#### パン（中ボタンドラッグ）

既存の `panX`/`panY` 変数に `stage.position()` を連動させます。既存のパン処理の末尾に以下を追加するだけで同期できます。

```js
// 既存パンロジックの末尾に追加
stage.position({ x: panX, y: panY });
stage.batchDraw();
```

## 実装ステップ（進捗）

1. ✅ `npm install konva` — `package.json` に `"konva": "^10.2.0"` 追加・`package-lock.json` 更新済み。
2. ✅ 既存の `.page-edge-layer`, `.page-top-layer`, `createEdgeLayers()`, `updateBookEdges()` などの DOM 実装を完全削除。
3. ✅ Konva を初期化：`initKonva()` で `stage`, `layer` を生成し、`#konva-mount` にマウント（PDF ロード時に 1 回）。
4. ✅ `renderPage()` の完了後に描画関数 `drawBookEdge(displayW, displayH)` を呼ぶ：
   - `count`, `highlightedIndex`, 各矩形の幅・位置を計算（`src/bookEdge.js` の純粋関数を使用）。
   - `Konva.Rect` を count 個生成（逆順で `layer.add`）。
   - 透明な `Konva.Line`（平行四辺形 right・top）を追加し、mousemove/mouseleave/click イベントをバインド。
   - ホバー更新は `requestAnimationFrame` で差分更新のみ（`updateEdgeGeometry()` 呼び出し）。
   - `layer.batchDraw()`。
5. ✅ ズーム・パンはスクロールベースを維持（ハイブリッド方式）。ズーム時は `renderPage()` が再呼ばれるため Konva も自動再描画。
6. ✅ `npm test` 全 63 件パス（`tests/book-edge.test.js` 31 件 + 既存 32 件）。

---

## 実際の実装と依頼書の仕様差分

| 仕様項目 | 依頼書の想定 | 実際の実装 | 理由 |
|----------|-------------|-----------|------|
| パン操作 | `stage.position()` でキャンバスごと移動 | `viewerContainer.scrollLeft/Top` スクロールを維持 | text-layer 座標・`fitWidth()` への影響を避けるため |
| ズーム操作 | `stage.scale()` で Konva Stage 全体をスケール | PDF.js `renderPage()` 再実行を維持 | スケール変更時も `drawBookEdge()` が呼ばれるため追従は自動 |
| PDF 本体の描画 | `Konva.Image` で Stage 内に取り込む | DOM `#pdf-canvas` を維持 | PDF.js テキストレイヤー・link レイヤーとの整合を保つため |
| Stage のマウント先 | `#pdf-container` 全面 | `#book-depth-wrapper` 内の `div#konva-mount` | DOM 構造への影響を最小化するため |
| CANVAS_PAD 計算 | 固定値想定 | `calcMaxEdgePx(totalPages)` で PDF ロード後に動的計算 | ページ数次第でエッジ幅が変わるため |
| `highlightedIndex` の意味 | ページ 1 専用（`index=0` が P.1 ハイライト） | 現在ページのスタック内相対位置 | 「現在どこにいるか」を視覚化する本来の目的に整合 |
| クリック遷移先 | `highlightedIndex` クリック → P.1 固定 | `highlightedIndex` クリック → **現在ページ維持** | 意図しない先頭ジャンプを防止 |

---

## 実装済みファイル一覧

| ファイル | 変更種別 | 内容 |
|----------|----------|------|
| `src/bookEdge.js` | **新規作成** | 純粋計算関数（`calcEdgeCount`, `calcMaxEdgePx`, `getHighlightedIndex`, `getRectWidths`, `calcCumulative`, `getPageForIndex`） |
| `tests/book-edge.test.js` | **新規作成** | 上記関数の自動テスト 31 件（境界条件・単調性・範囲チェック） |
| `src/app.js` | **大幅改修** | 旧 Book Depth 削除、Konva import 追加、`initKonva` / `drawBookEdge` / `updateEdgeGeometry` 追加 |
| `src/style.css` | **改修** | `.page-edge-layer` / `.page-top-layer` 削除、`#konva-mount` スタイル追加、`#book-depth-wrapper` に `overflow: visible` 追加 |
| `package.json` | **改修** | `"konva": "^10.2.0"` を `dependencies` に追加 |

---

## 実装の知見・設計 Tips（後続作業者向け）

### 座標系：`#konva-mount` の `top: -maxEdge` オフセット

```
#book-depth-wrapper  (position: relative, overflow: visible)
│
├── div#konva-mount  (position: absolute; top: -maxEdge; left: 0; z-index: 0)
│    └── Konva Stage  (width: displayW + maxEdge, height: displayH + maxEdge)
│         └── Layer
│              ├── Rect × count  ← エッジ矩形（listening: false）
│              ├── Line hitRight ← 透明平行四辺形（listening: true）
│              └── Line hitTop   ← 透明平行四辺形（listening: true）
│
└── #pdf-canvas  (z-index: 1, position: relative)
```

**なぜ `top: -maxEdge` か？**
上方向エッジを描画するには「PDF 上端より上」に矩形を置く必要がある。
Konva の Stage 内座標では負の y が必要になるが、Stage はデフォルトで `(0,0)` 起点であり
Stage のサイズ外にはレンダリングされない（クリップされる）。

そのため mountDiv を `top: -maxEdge` でオフセット配置し、
Stage 内では PDF 上端 = `y = maxEdge` として描画することで
上エッジ矩形が Stage 内に収まるようにしている（Stage の y=0 は画面上の PDF 上端より `maxEdge` 上）。

```
DOM y 座標（viewerContainer 起点）:
  PDF 上端 - maxEdge  ← konva-mount の top
      ↕ maxEdge
  PDF 上端（wrapper 上端）
      ↕ displayH
  PDF 下端

Stage y 座標:
  y=0  ← konva-mount 上端 = PDF 上端 - maxEdge
  y=maxEdge  ← PDF 上端（ここに originY を設定）
  y=maxEdge+displayH  ← PDF 下端
```

### `updateEdgeGeometry()` — ホバー差分更新

`mousemove` 発生のたびに `drawBookEdge()` を呼ぶと Layer の `destroyChildren()` が走り重い。
そのため、次の 2 段構えで軽量化している。

1. **変化検出**: `newIdx === konvaHoveredIdx` であれば早期 return。
2. **rAF バッファ**: 変化があっても即座に描画せず、`requestAnimationFrame` で次フレームに合流。
   `konvaRafPending` フラグで二重 rAF を防ぐ。

```js
// 変化があるときだけ rAF でバッファ
if (newIdx === konvaHoveredIdx) return;
konvaHoveredIdx = newIdx;
if (!konvaRafPending) {
  konvaRafPending = true;
  requestAnimationFrame(() => {
    konvaRafPending = false;
    updateEdgeGeometry();
  });
}
```

`updateEdgeGeometry()` はノードの `x/y/width/height/points` プロパティを直接変更するだけで
`layer.destroyChildren()` は呼ばない。ホバーは差分、ページ遷移は全面再構築と使い分けている。

### ヒット判定：`getHoveredIdxFromEvent()`

依頼書は `getAbsoluteTransform().copy().invert()` を使ったローカル座標変換を提案しているが、
本実装では Stage スケールを使っていないため `konvaStage.getPointerPosition()` の座標をそのまま使用。

```js
// 右エッジのヒット判定（Stage 座標系）
const localX = pos.x - (originX + displayW);  // PDF 右端からの距離
// i 番目のスロット = cumX[i-1] 〜 cumX[i] の範囲
```

上エッジも同様に `localY = originY - pos.y`（PDF 上端からの上方向距離）で判定。
`getPointerPosition()` はウィンドウリサイズ後も自動的にスケール補正されるため使いやすい。

### `CANVAS_PAD_TOP/RIGHT` の動的更新タイミング

`updateCanvasPad(totalPages)` は `openFileFromData()` 内で PDF ロード直後、
`renderPage()` 呼び出し**前**に実行する。

これにより、`renderPage()` 内で `CANVAS_PAD_TOP` を参照する text-layer 座標計算が
新しい padding 値で正しく動作する。

```js
// openFileFromData() 内の順序（重要）
state.totalPages = pdf.numPages;
updateCanvasPad(state.totalPages);  // ← ここで CANVAS_PAD_* を確定
// ...
await renderPage(state.currentPage); // ← CANVAS_PAD_TOP を参照する text-layer 計算
```

### `pointer-events` の 2 層構成

```css
#konva-mount {
  pointer-events: none;  /* Stage の外枠はクリック透過 */
}
#konva-mount canvas {
  pointer-events: auto;  /* Konva Canvas 本体は受け取る */
}
```

Konva 内部では `listening: false` の Rect はヒット判定から外れる（クリック透過）。
`listening: true` の `hitRight` / `hitTop` Line のみがイベントを受ける。

**注意**: Konva は `listening: false` のノードのクリックを DOM にバブルさせるが、
`pointer-events: none` の親要素があるとブラウザが先に無視するため、
CSS と Konva の設定を両方合わせる必要がある。

### `initKonva()` は PDF ごとに 1 回

PDF を開き直すたびに `initKonva()` が呼ばれ、前の Stage が `konvaStage.destroy()` される。
`drawBookEdge()` はページが変わるたびに呼ばれ Layer を再構築するが、
Stage/Layer オブジェクト自体は使い回すため `initKonva()` を重ねて呼ばない。

---

## 検証手順

```powershell
cd C:\Users\sasai\Documents\PyMuPDF
npm run dev
```

### 自動テスト（完了）

```powershell
npm test
# → 63 件全パス（book-edge: 31 件 + pdf-viewer: 32 件）
```

### 手動確認チェックリスト

1. PDF 読込後、右・上の影が「背面に矩形を重ねる方式」により、角の部分で完璧に繋がり「積み重なった紙」に見えるか。
2. 影レイヤーにカーソルを合わせると該当箇所が少し拡幅し（ホバー効果）、クリックで対応するページへとジャンプできるか（先頭に飛ばずに正しいページへ）。
3. ページをめくることで、ハイライトされる帯の位置が移動し、現在位置がスタック内で視覚的にわかるか。
4. 中ボタンドラッグによるパン移動に対して、Konva 上の影と PDF 画像がスクロールで一体的に追従するか。
5. Ctrl+Wheel ズーム後も影のサイズ・位置が PDF と一致して再描画されるか。
6. 1 ページのみの PDF を開いてもエラーが出ないか（`count=0` で影なし、正常終了）。
