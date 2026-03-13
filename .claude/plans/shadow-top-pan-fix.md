# 修正計画書 v3：影の上＋右表示 / 影数ロジック調整 / 中ボタンパン

作成日：2026-03-12  
更新日：2026-03-12（v2 指摘事項を全反映）

---

## 前提確認

| 確認項目 | 採用方針 |
|----------|----------|
| 中ボタンパンの有効条件 | 常時有効（ズーム問わず） |
| text-layer ズレ回避 | JS の `+24` オフセットを定数化し、`padding-top` 変更と連動させる |
| 上部レイヤーの配置場所 | `book-depth-wrapper` **内** に `position: absolute` で統一（これのみ採用） |
| 上部レイヤーの展開方向 | `bottom: calc(100% + Npx)` で配置してホバー時に**上方向**に拡大 |

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|----------|----------|
| `src/app.js` | ① `BOOK_DEPTH` + `MAX_LAYER_DEPTH` + `CANVAS_PAD_TOP/RIGHT` 定数追加、② **モジュール初期化時に1回だけ**パディング設定、③ text-layer offset 修正、④ `updateBookEdges()` リファクタ（共通ヘルパー + 上方向追加）、⑤ クリック委譲修正、⑥ 中ボタンパン追加、⑦ `fitWidth()` を動的パディング参照に修正 |
| `src/style.css` | ① `.page-top-layer` 追加（`bottom` ベース）、② `#pdf-container` はデフォルト CSS を削除して JS で制御、③ パン中カーソル、④ ホバー幅修正 |

---

## 詳細設計

### ① 定数追加（`app.js` 冒頭）

```js
const BOOK_DEPTH = {
    pagesPerLayer: 30,    // 50 → 30
    maxLayers:     10,    // 6  → 10
    normalWidth:   4,     // px（右・上共通）
    highlightMul:  8,
};

// pdf-container の上/右パディング
// ハイライト層(highlightMul倍)を含む最大深さ = normalWidth × (maxLayers - 1 + highlightMul)
// text-layer の座標オフセット(top)はこの値と連動する
// left パディングは 24px 固定のまま
const MAX_LAYER_DEPTH  = BOOK_DEPTH.normalWidth
    * (BOOK_DEPTH.maxLayers - 1 + BOOK_DEPTH.highlightMul);
//     = 4 × (10 - 1 + 8) = 4 × 17 = 68px
const CANVAS_PAD_TOP   = 24 + MAX_LAYER_DEPTH;  // = 92px
const CANVAS_PAD_RIGHT = 24 + MAX_LAYER_DEPTH;  // = 92px
```

---

### ② `#pdf-container` パディングを JS で設定

`openFileFromData()` 内（もしくはモジュール初期化時）で1回だけ実行：

```js
// pdf-container のパディングを定数から設定（モジュール初期化時に1回のみ）
// CSS のデフォルト値（padding: 24px）は上書きされる
els.pdfContainer.style.paddingTop   = CANVAS_PAD_TOP + 'px';
els.pdfContainer.style.paddingRight = CANVAS_PAD_RIGHT + 'px';
// bottom / left は元のまま（40px / 24px）は CSS 側に残す
```

> **なぜ JS で設定するか？**  
> `CANVAS_PAD_TOP` は `BOOK_DEPTH` から算出されるため、定数の変更が自動で CSS に反映される。  
> CSS に直書きすると JS 定数と乖離するリスクがある。

---

### ③ text-layer の top オフセット修正（`app.js` L221）

```js
// 変更前
span.style.top = tx[5] - fontSize + 24 + "px";

// 変更後（CANVAS_PAD_TOP と連動）
span.style.top = tx[5] - fontSize + CANVAS_PAD_TOP + "px";
// left のパディングは 24px 固定のまま変更なし
span.style.left = tx[4] + 24 + "px";
```

---

### ④ `updateBookEdges()` リファクタ（共通ヘルパー + 上方向追加）

**配置ルール（統一）：**  
- 右・上ともに `book-depth-wrapper` 内の `position: absolute` で配置
- **右**: `left: calc(100% + Npx)` → `width` が拡大 → 右方向に伸びる（既存通り）
- **上**: `bottom: calc(100% + Npx)` → `height` が拡大 → **上方向**に伸びる（v2 の `top` 方式を廃止）

```js
/**
 * 右 or 上 の edge レイヤーを生成して wrapper に追加
 * @param {'right'|'top'} direction
 */
function createEdgeLayers(wrapper, numLayers, highlightIdx, direction) {
    let cumOffset = 0;
    for (let i = 0; i < numLayers; i++) {
        const isHighlighted = (i === highlightIdx);
        const size = isHighlighted
            ? BOOK_DEPTH.normalWidth * BOOK_DEPTH.highlightMul
            : BOOK_DEPTH.normalWidth;
        const pageNum = isHighlighted
            ? 1
            : getLayerPageNumber(i, numLayers, state.totalPages);

        const layer = document.createElement('div');

        if (direction === 'right') {
            layer.className = 'page-edge-layer' + (isHighlighted ? ' highlighted' : '');
            layer.style.left  = `calc(100% + ${cumOffset}px)`;
            layer.style.width = size + 'px';
        } else {
            // top: bottom ベースで配置 → hover 時に上方向に伸びる
            layer.className = 'page-top-layer' + (isHighlighted ? ' highlighted' : '');
            layer.style.bottom  = `calc(100% + ${cumOffset}px)`;
            layer.style.height  = size + 'px';
        }

        layer.dataset.targetPage = pageNum;
        layer.title = `P. ${pageNum}`;
        wrapper.appendChild(layer);
        cumOffset += size;
    }
}

function updateBookEdges() {
    if (!state.pdf) return;
    const wrapper = els.bookDepthWrapper;
    const canvas  = els.canvas;
    wrapper.innerHTML = '';
    wrapper.appendChild(canvas);

    const numLayers    = calcNumLayers(state.currentPage, state.totalPages);
    if (numLayers === 0) return;
    const highlightIdx = getHighlightedLayerIndex(
        state.currentPage, state.totalPages, numLayers
    );

    createEdgeLayers(wrapper, numLayers, highlightIdx, 'right');
    createEdgeLayers(wrapper, numLayers, highlightIdx, 'top');
}
```

---

### ⑤ クリック委譲の修正（`app.js` L685〜693）

```js
els.bookDepthWrapper.addEventListener('click', (e) => {
    // [修正] page-top-layer も対象に追加
    const edge = e.target.closest('.page-edge-layer, .page-top-layer');
    if (!edge || !edge.dataset.targetPage) return;
    const pageNum = Number(edge.dataset.targetPage);
    if (!isNaN(pageNum)) goToPage(pageNum);
});
```

---

### ⑥ 中ボタンドラッグによるパン移動（`app.js` 末尾に追加）

```js
// ---- Middle Mouse Button Pan ----
(function initMiddleMousePan() {
    let isPanning  = false;
    let startX     = 0;
    let startY     = 0;
    let scrollLeft = 0;
    let scrollTop  = 0;
    const container = els.viewerContainer;

    function stopPanning() {
        isPanning = false;
        container.classList.remove('is-panning');
    }

    container.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();               // ブラウザのオートスクロール抑制
        isPanning  = true;
        startX     = e.clientX;
        startY     = e.clientY;
        scrollLeft = container.scrollLeft;
        scrollTop  = container.scrollTop;
        container.classList.add('is-panning');
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        container.scrollLeft = scrollLeft - (e.clientX - startX);
        container.scrollTop  = scrollTop  - (e.clientY - startY);
    });

    // isPanning フラグで終了（ボタン種別を問わない）
    window.addEventListener('mouseup', () => {
        if (isPanning) stopPanning();
    });

    // ウィンドウフォーカスが外れた場合も確実に解除
    window.addEventListener('blur', () => {
        if (isPanning) stopPanning();
    });

    // 中ボタンデフォルト動作（オートスクロールアイコン表示）を抑制
    container.addEventListener('auxclick', (e) => {
        if (e.button === 1) e.preventDefault();
    });
})();
```

---

### ⑦ CSS 変更（`style.css`）

```css
/* パン中カーソル（can-pan は追加しない） */
#viewer-container.is-panning {
    cursor: grabbing !important;
    user-select: none;
}

/* 上部ページ端レイヤー
   bottom ベースで配置 → height 増加が上方向（ページ外側）に伸びる */
.page-top-layer {
    position: absolute;
    left:   0;
    width:  100%;
    z-index: 0;
    background: #f5f5f5;
    border-top: 1px solid rgba(0, 0, 0, 0.18);
    cursor: pointer;
    box-sizing: border-box;
    transition: height 0.12s ease, background 0.12s ease;
}

.page-top-layer:not(.highlighted):hover {
    height: 16px !important;  /* normalWidth(4) × hoverMul(4)。上方向に拡大する */
    background: #e8e8f8;
}

.page-top-layer.highlighted {
    background: #ebebeb;
    border-top: 1px solid rgba(0, 0, 0, 0.25);
}

/* 右ページ端のホバー幅を normalWidth(4) × 4 に合わせる */
.page-edge-layer:not(.highlighted):hover {
    width: 16px !important;  /* normalWidth(4) × hoverMul(4) */
}

/* 上ページ端のホバー高さを normalWidth(4) × 4 に合わせる */
.page-top-layer:not(.highlighted):hover {
    height: 16px !important;  /* normalWidth(4) × hoverMul(4)。上方向に拡大する */
    background: #e8e8f8;
}

/* #pdf-container の padding-top / padding-right は JS で設定するため
   CSS 側のデフォルト値は baseline の 24px に合わせておく。
   JS 起動時に CANVAS_PAD_TOP / CANVAS_PAD_RIGHT で上書きされる。 */
#pdf-container {
    padding: 24px;
    padding-right: 40px;  /* JS上書き前のデフォルト */
    padding-bottom: 40px;
}
```

---

## 検証計画

```powershell
cd C:\Users\sasai\Documents\PyMuPDF
npm run dev
```

ブラウザでアプリを開き、複数ページのPDFを読み込んで下表を確認：

| # | 確認内容 | 期待動作 | 対応修正 |
|---|----------|----------|----------|
| 1 | 右側の影 | 右に最大10層積み重なる | ① |
| 2 | 上部の影 | 上に最大10層積み重なる | ④ |
| 3 | 上部レイヤーのホバー | **上方向**に拡大し、ページ本文を隠さない | ⑦ (bottom 方式) |
| 4 | 右の影クリック | 対応ページへ移動 | ⑤ |
| 5 | 上の影クリック | 対応ページへ移動 | ⑤ |
| 6 | テキスト選択位置 | ページ文字と選択範囲がズレない | ②③ |
| 7 | 中ボタンドラッグ | ドラッグでスクロール移動する | ⑥ |
| 8 | ウィンドウ外でボタン離す | カーソルが grabbing のまま残らない | ⑥ |
| 9 | Alt+Tab 後 | カーソルが grabbing のまま残らない | ⑥ (blur) |
| 10 | ページ変更後 | 影の枚数・位置が正しく更新される | ④ |
