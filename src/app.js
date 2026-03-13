/* ============================================
   PDF Viewer - Application Logic
   ============================================ */

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import * as pdfjsLib from "pdfjs-dist";
import Konva from "konva";
import {
    calcEdgeCount,
    calcMaxEdgePx,
    getHighlightedIndex,
    getRectWidths,
    calcCumulative,
    getPageForIndex,
    EDGE_INTERVAL,
} from "./bookEdge.js";

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
).toString();

// ---- Canvas padding（ページ数確定後に動的計算、初期値は暫定値） ----
// calcMaxEdgePx(totalPages) が確定したら updateCanvasPad() で更新する。
let CANVAS_PAD_TOP   = 100;  // 暫定値（PDF ロード前のレイアウト用）
let CANVAS_PAD_RIGHT = 100;
const CANVAS_PAD_LEFT = 24;  // 固定（fitWidth 計算用）

/** totalPages が確定したあとに padding を再計算する */
function updateCanvasPad(totalPages) {
    const maxEdge = calcMaxEdgePx(totalPages);
    CANVAS_PAD_TOP   = 24 + maxEdge;
    CANVAS_PAD_RIGHT = 24 + maxEdge;
    els.pdfContainer.style.paddingTop   = CANVAS_PAD_TOP   + 'px';
    els.pdfContainer.style.paddingRight = CANVAS_PAD_RIGHT + 'px';
}

// ---- State ----
const state = {
    pdf: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.0,
    filePath: null,
    rendering: false,
    pendingPage: null,
    outline: null,
    activeSidebarTab: 'toc',
    thumbObserver: null,
};

// ---- DOM Elements ----
const els = {
    btnOpen: document.getElementById("btn-open"),
    btnWelcomeOpen: document.getElementById("btn-welcome-open"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
    btnFitWidth: document.getElementById("btn-fit-width"),
    btnToc: document.getElementById("btn-toc"),
    btnThumbnails: document.getElementById("btn-thumbnails"),
    btnTocClose: document.getElementById("btn-toc-close"),
    pageInput: document.getElementById("page-input"),
    pageTotal: document.getElementById("page-total"),
    zoomLevel: document.getElementById("zoom-level"),
    searchInput: document.getElementById("search-input"),
    welcomeScreen: document.getElementById("welcome-screen"),
    pdfContainer: document.getElementById("pdf-container"),
    canvas: document.getElementById("pdf-canvas"),
    textLayer: document.getElementById("text-layer"),
    tocPanel: document.getElementById("toc-panel"),
    tocPane: document.getElementById("toc-pane"),
    thumbnailsPane: document.getElementById("thumbnails-pane"),
    thumbnailsList: document.getElementById("thumbnails-list"),
    sidebarTabs: document.querySelectorAll(".sidebar-tab"),
    tocList: document.getElementById("toc-list"),
    fileName: document.getElementById("file-name"),
    statusInfo: document.getElementById("status-info"),
    viewerContainer: document.getElementById("viewer-container"),
    bookDepthWrapper: document.getElementById("book-depth-wrapper"),
};

// ---- Konva State ----
let konvaStage  = null;
let konvaLayer  = null;
let edgeRects   = [];
let hitRight    = null;
let hitTop      = null;
let konvaHoveredIdx    = -1;
let konvaHighlightedIdx = -1;
let konvaRafPending    = false;
let konvaDisplayW = 0;
let konvaDisplayH = 0;

// ---- Stripe Pattern Canvas ----
const stripeCanvas = document.createElement('canvas');
stripeCanvas.width = 6;
stripeCanvas.height = 6;
const sCtx = stripeCanvas.getContext('2d');
sCtx.fillStyle = '#f5f5f5';
sCtx.fillRect(0, 0, 6, 6);
sCtx.strokeStyle = 'rgba(0,0,0,0.2)';
sCtx.lineWidth = 1;
sCtx.beginPath();
sCtx.moveTo(0, 6);
sCtx.lineTo(6, 0);
sCtx.stroke();

// ---- PDF Loading ----

/** ファイルパスを直接渡してPDFを読み込む（Tauri環境用） */
async function openFileByPath(filePath) {
    try {
        els.statusInfo.textContent = "読み込み中...";
        const fileBytes = await readFile(filePath);
        const pathParts = filePath.replace(/\\/g, "/").split("/");
        await openFileFromData(fileBytes, pathParts[pathParts.length - 1]);
    } catch (err) {
        console.error("Failed to open PDF:", err);
        els.statusInfo.textContent = "エラー: ファイルを開けませんでした";
    }
}

/** Uint8Array とファイル名を受け取ってPDFを描画する共通処理 */
async function openFileFromData(uint8Array, fileName) {
    try {
        els.statusInfo.textContent = "読み込み中...";
        if (state.pdf) {
            state.pdf.destroy();
            state.pdf = null;
        }
        state.filePath = fileName;

        const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
        const pdf = await loadingTask.promise;

        state.pdf = pdf;
        state.totalPages = pdf.numPages;
        state.currentPage = 1;
        state.scale = 1.0;

        // ページ数確定後にパディングを再計算
        updateCanvasPad(state.totalPages);

        // Update UI
        els.pageTotal.textContent = state.totalPages;
        els.pageInput.max = state.totalPages;
        els.fileName.textContent = fileName;

        // Show PDF, hide welcome
        els.welcomeScreen.style.display = "none";
        els.pdfContainer.classList.remove("hidden");

        // Enable nav buttons
        updateNavButtons();
        updateZoomDisplay();

        // Konva ステージを初期化（PDF ごとに 1 回）
        initKonva();

        // Load outline
        loadOutline();

        // Initialize thumbnails AFTER basic render setup
        // drawBookEdge は renderPage 完了後に自動呼び出されるため不要
        await renderPage(state.currentPage);
        initThumbnails();

        els.statusInfo.textContent = "";

    } catch (err) {
        console.error("Failed to open PDF:", err);
        els.statusInfo.textContent = "エラー: ファイルを開けませんでした";
    }
}

/** ダイアログでファイルを選択して開く */
async function openFile() {
    if (window.__TAURI_INTERNALS__) {
        // Tauri環境: ネイティブダイアログを使う
        try {
            const selected = await open({
                multiple: false,
                filters: [{ name: "PDF", extensions: ["pdf"] }],
            });

            if (!selected) return;

            const filePath = typeof selected === "string" ? selected : selected.path;
            if (!filePath) return;

            await openFileByPath(filePath);
        } catch (err) {
            console.error("Failed to open PDF:", err);
            els.statusInfo.textContent = "エラー: ファイルを開けませんでした";
        }
    } else {
        // ブラウザ環境: input要素を動的生成してファイル選択
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".pdf";
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            els.statusInfo.textContent = "読み込み中...";
            await openFileFromData(new Uint8Array(await file.arrayBuffer()), file.name);
        };
        input.click();
    }
}

// ---- Page Rendering ----
async function renderPage(pageNum) {
    if (!state.pdf) return;

    if (state.rendering) {
        state.pendingPage = pageNum;
        return;
    }

    state.rendering = true;
    state.currentPage = pageNum;
    els.pageInput.value = pageNum;
    updateNavButtons();
    updateActiveThumbnail(pageNum);

    try {
        const page = await state.pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale * window.devicePixelRatio });
        const displayViewport = page.getViewport({ scale: state.scale });

        const canvas = els.canvas;
        const context = canvas.getContext("2d");
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const widthPx = displayViewport.width + "px";
        const heightPx = displayViewport.height + "px";
        canvas.style.width = widthPx;
        canvas.style.height = heightPx;

        // Sync wrapper size
        els.bookDepthWrapper.style.width = widthPx;
        els.bookDepthWrapper.style.height = heightPx;

        // Konva エッジ描画用にサイズを保持
        konvaDisplayW = displayViewport.width;
        konvaDisplayH = displayViewport.height;

        const renderContext = {
            canvasContext: context,
            viewport: viewport,
        };

        await page.render(renderContext).promise;

        // Build text layer
        els.textLayer.innerHTML = "";
        const textContent = await page.getTextContent();
        const textItems = textContent.items;

        for (const item of textItems) {
            const span = document.createElement("span");
            const tx = pdfjsLib.Util.transform(
                displayViewport.transform,
                item.transform
            );

            const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
            span.style.left = tx[4] + CANVAS_PAD_LEFT + "px";
            span.style.top  = tx[5] - fontSize + CANVAS_PAD_TOP + "px";
            span.style.fontSize = fontSize + "px";
            span.style.fontFamily = item.fontName || "sans-serif";
            span.textContent = item.str;

            els.textLayer.appendChild(span);
        }

        els.statusInfo.textContent = `${pageNum} / ${state.totalPages} ページ`;
    } catch (err) {
        console.error("Render error:", err);
    }

    state.rendering = false;

    // ページサイズ確定後（wrapper width/height 設定後）に Konva エッジを再描画
    drawBookEdge(konvaDisplayW, konvaDisplayH);

    if (state.pendingPage !== null) {
        const nextPage = state.pendingPage;
        state.pendingPage = null;
        renderPage(nextPage);
    }
}

// ---- Navigation ----
function goToPage(pageNum) {
    if (!state.pdf) return;
    const page = Math.max(1, Math.min(pageNum, state.totalPages));
    if (page !== state.currentPage) {
        // updateBookEdges() は renderPage() の完了後に呼ぶ必要がある。
        // renderPage 内部で wrapper の width/height を確定するため、
        // ここで先に呼ぶと古いサイズのまま edge が配置される。
        // → renderPage の末尾（state.rendering = false の後）で呼ぶ設計に変更済み。
        renderPage(page);
    }
}

function prevPage() {
    goToPage(state.currentPage - 1);
}

function nextPage() {
    goToPage(state.currentPage + 1);
}

function updateNavButtons() {
    els.btnPrev.disabled = !state.pdf || state.currentPage <= 1;
    els.btnNext.disabled = !state.pdf || state.currentPage >= state.totalPages;
}

// ---- Konva Book Edge ----

/** Konva Stage と Layer を初期化する（PDF ロード時に 1 回呼ぶ） */
function initKonva() {
    // 既存 Stage があれば破棄
    if (konvaStage) {
        konvaStage.destroy();
        konvaStage = null;
        konvaLayer = null;
        edgeRects = [];
        hitRight = null;
        hitTop = null;
    }

    // konva-mount div を取得または作成
    let mountDiv = document.getElementById('konva-mount');
    if (!mountDiv) {
        mountDiv = document.createElement('div');
        mountDiv.id = 'konva-mount';
        els.bookDepthWrapper.insertBefore(mountDiv, els.bookDepthWrapper.firstChild);
    }

    konvaStage = new Konva.Stage({
        container: 'konva-mount',
        width: 1,
        height: 1,
    });
    konvaLayer = new Konva.Layer();
    konvaStage.add(konvaLayer);
    konvaHoveredIdx = -1;
}

/**
 * エッジの Konva ノード（Rect × count、透明 Line × 2）を
 * 現在の状態に合わせて更新する。
 * hoveredIdx/-1 が変化したときだけ呼ばれる差分更新関数。
 */
function updateEdgeGeometry() {
    if (!konvaLayer || edgeRects.length === 0) return;

    const count = edgeRects.length;
    const widths = getRectWidths(count, konvaHoveredIdx, konvaHighlightedIdx);
    const cumX = calcCumulative(widths);
    const cumY = calcCumulative(widths); // X/Y は同幅

    const maxEdge = calcMaxEdgePx(state.totalPages);
    const originX = 0;       // PDF 左端 x（矩形は PDF の背後から始まる）
    const originY = maxEdge; // Stage 座標系での PDF 上端 y

    for (let i = count - 1; i >= 0; i--) {
        const currentCumX = cumX[i];
        const currentCumY = cumY[i];
        const rect = edgeRects[i];
        // PDF 左端からオフセット（矩形は PDF の背後に置かれ、右端・上端からはみ出す）
        rect.x(originX + currentCumX);
        // 上へのズレ: 手前 (i 小) ほど上に配置
        rect.y(originY - currentCumY);
        rect.width(konvaDisplayW);
        rect.height(konvaDisplayH);
    }

    // 右側 hit polygon 更新
    const totalEdge = cumX[count - 1];
    if (hitRight) {
        hitRight.points([
            originX + konvaDisplayW, originY,
            originX + konvaDisplayW + totalEdge, originY - totalEdge,
            originX + konvaDisplayW + totalEdge, originY + konvaDisplayH - totalEdge,
            originX + konvaDisplayW, originY + konvaDisplayH,
        ]);
    }
    if (hitTop) {
        hitTop.points([
            originX, originY,
            originX + totalEdge, originY - totalEdge,
            originX + konvaDisplayW + totalEdge, originY - totalEdge,
            originX + konvaDisplayW, originY,
        ]);
    }

    konvaLayer.batchDraw();
}

/**
 * ページ再描画後に呼ぶ全面再構築関数。
 * Konva ノードを全て作り直し、イベントを再バインドする。
 * @param {number} displayW  CSS 表示幅 (px)
 * @param {number} displayH  CSS 表示高さ (px)
 */
function drawBookEdge(displayW, displayH) {
    if (!state.pdf || !konvaStage || !konvaLayer) return;

    konvaDisplayW = displayW;
    konvaDisplayH = displayH;

    const count = calcEdgeCount(state.totalPages);
    konvaHighlightedIdx = getHighlightedIndex(
        state.currentPage,
        state.totalPages,
        count
    );

    // Stage のサイズを PDF + エッジ領域に合わせる
    const maxEdge = calcMaxEdgePx(state.totalPages);
    const stageW = displayW + maxEdge;
    const stageH = displayH + maxEdge;
    konvaStage.width(stageW);
    konvaStage.height(stageH);

    // Stage の絶対位置を「PDF canvas の左上」に揃えるため、
    // wrapper 内で (0, 0) が PDF 左上になるよう配置している。
    // エッジは右（+x）・上（-y → Stage 内で y < 0 にならないよう上方向に余白が必要）
    // → Stage の DOM 位置を top: -maxEdge, left: 0 にしてオフセット
    const mountDiv = document.getElementById('konva-mount');
    if (mountDiv) {
        mountDiv.style.position = 'absolute';
        mountDiv.style.top      = (-maxEdge) + 'px';
        mountDiv.style.left     = '0px';
        mountDiv.style.zIndex   = '0';
    }
    // Stage を mountDiv のオフセット分だけ y 方向にずらす
    // → Konva の y 座標 0 = PDF 上端、負 y = 上エッジ領域
    // Stage 自体は top:-maxEdge なので、PDF 上端は Stage 内で y = maxEdge
    const originY = maxEdge; // Stage 座標系での PDF 上端 y
    const originX = 0;       // PDF 左端 x

    // Layer クリア
    konvaLayer.destroyChildren();
    edgeRects = [];
    hitRight = null;
    hitTop = null;

    if (count === 0) {
        konvaLayer.batchDraw();
        return;
    }

    const widths = getRectWidths(count, konvaHoveredIdx, konvaHighlightedIdx);
    const cumX = calcCumulative(widths);
    const cumY = calcCumulative(widths);

    // 矩形を奥（大インデックス）から手前（小インデックス）の順で追加
    // 各矩形は PDF と同サイズ（displayW × displayH）で PDF の背後に重なるように配置。
    // originX + currentCumX = PDF 左端からオフセット → 右端と上端だけがはみ出して見える。
    for (let i = count - 1; i >= 0; i--) {
        const currentCumX = cumX[i];
        const currentCumY = cumY[i];

        const rectConfig = {
            x: originX + currentCumX,
            y: originY - currentCumY,
            width:  displayW,
            height: displayH,
            stroke: 'rgba(0,0,0,0.18)',
            strokeWidth: 1,
            listening: false,
        };

        if (i === 0) {
            rectConfig.fillPatternImage = stripeCanvas;
            rectConfig.fillPatternRepeat = 'repeat';
        } else {
            rectConfig.fill = '#f5f5f5';
        }

        const rect = new Konva.Rect(rectConfig);
        konvaLayer.add(rect);
        edgeRects[i] = rect;
    }

    // 右側 ヒット用透明ポリゴン
    const totalEdge = cumX[count - 1];
    hitRight = new Konva.Line({
        points: [
            originX + displayW, originY,
            originX + displayW + totalEdge, originY - totalEdge,
            originX + displayW + totalEdge, originY + displayH - totalEdge,
            originX + displayW, originY + displayH,
        ],
        closed: true,
        opacity: 0,
        listening: true,
    });

    // 上側 ヒット用透明ポリゴン
    hitTop = new Konva.Line({
        points: [
            originX, originY,
            originX + totalEdge, originY - totalEdge,
            originX + displayW + totalEdge, originY - totalEdge,
            originX + displayW, originY,
        ],
        closed: true,
        opacity: 0,
        listening: true,
    });

    // ---- イベントハンドラ共通ロジック ----
    function getHoveredIdxFromEvent(e, isRight) {
        const pos = konvaStage.getPointerPosition();
        if (!pos) return -1;
        const localX = pos.x - (isRight ? (originX + displayW) : originX);
        const localY = (originY) - pos.y;
        // 右エッジ: x 方向で判定
        const axis = isRight ? localX : localY;
        if (axis < 0) return -1;
        for (let i = 0; i < cumX.length; i++) {
            const start = i === 0 ? 0 : cumX[i - 1];
            const end = cumX[i];
            if (axis >= start && axis < end) return i;
        }
        return count - 1;
    }

    function onHoverMove(e, isRight) {
        const newIdx = getHoveredIdxFromEvent(e, isRight);
        if (newIdx === konvaHoveredIdx) return;
        konvaHoveredIdx = newIdx;
        if (!konvaRafPending) {
            konvaRafPending = true;
            requestAnimationFrame(() => {
                konvaRafPending = false;
                updateEdgeGeometry();
            });
        }
    }

    function onLeave() {
        if (konvaHoveredIdx === -1) return;
        konvaHoveredIdx = -1;
        if (!konvaRafPending) {
            konvaRafPending = true;
            requestAnimationFrame(() => {
                konvaRafPending = false;
                updateEdgeGeometry();
            });
        }
    }

    function onClick(e, isRight) {
        const idx = getHoveredIdxFromEvent(e, isRight);
        if (idx < 0) return;
        const page = getPageForIndex(
            idx,
            konvaHighlightedIdx,
            state.currentPage,
            state.totalPages,
            count
        );
        goToPage(page);
    }

    hitRight.on('mousemove', (e) => onHoverMove(e, true));
    hitRight.on('mouseleave', onLeave);
    hitRight.on('click', (e) => onClick(e, true));
    hitTop.on('mousemove', (e) => onHoverMove(e, false));
    hitTop.on('mouseleave', onLeave);
    hitTop.on('click', (e) => onClick(e, false));

    konvaLayer.add(hitRight);
    konvaLayer.add(hitTop);

    konvaLayer.batchDraw();
}

// ---- Zoom ----
function setZoom(newScale) {
    state.scale = Math.max(0.25, Math.min(5.0, newScale));
    updateZoomDisplay();
    if (state.pdf) {
        renderPage(state.currentPage);
    }
}

function zoomIn() {
    setZoom(state.scale + 0.25);
}

function zoomOut() {
    setZoom(state.scale - 0.25);
}

async function fitWidth() {
    if (!state.pdf) return;
    const page = await state.pdf.getPage(state.currentPage);
    const viewport = page.getViewport({ scale: 1.0 });
    // CANVAS_PAD_RIGHT（右余白）＋ CANVAS_PAD_LEFT（左余白）＋ スクロールバー幅
    const hPad = CANVAS_PAD_RIGHT + CANVAS_PAD_LEFT + 16;
    const containerWidth = els.viewerContainer.clientWidth - hPad;
    setZoom(containerWidth / viewport.width);
}

function updateZoomDisplay() {
    els.zoomLevel.textContent = Math.round(state.scale * 100) + "%";
}

// ---- Outline / TOC ----
async function loadOutline() {
    if (!state.pdf) return;

    try {
        const outline = await state.pdf.getOutline();
        state.outline = outline;
        renderOutline(outline);
    } catch (err) {
        console.error("Failed to load outline:", err);
    }
}

function renderOutline(items, container = null, level = 0) {
    if (!items || items.length === 0) {
        if (level === 0) {
            els.tocList.innerHTML = '<div style="padding: 16px; color: var(--text-muted); font-size: 13px;">目次がありません</div>';
        }
        return;
    }

    const target = container || els.tocList;
    if (level === 0) target.innerHTML = "";

    for (const item of items) {
        const btn = document.createElement("button");
        btn.className = "toc-item";
        btn.style.paddingLeft = 16 + level * 16 + "px";
        btn.textContent = item.title;

        btn.addEventListener("click", async () => {
            if (item.dest) {
                try {
                    let dest = item.dest;
                    if (typeof dest === "string") {
                        dest = await state.pdf.getDestination(dest);
                    }
                    if (dest) {
                        const pageIndex = await state.pdf.getPageIndex(dest[0]);
                        goToPage(pageIndex + 1);
                    }
                } catch (err) {
                    console.error("TOC navigation error:", err);
                }
            }
        });

        target.appendChild(btn);

        if (item.items && item.items.length > 0) {
            renderOutline(item.items, target, level + 1);
        }
    }
}

function switchSidebarTab(tab) {
    state.activeSidebarTab = tab;
    els.sidebarTabs.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    els.tocPane.classList.toggle("active", tab === "toc");
    els.thumbnailsPane.classList.toggle("active", tab === "thumbnails");

    if (tab === "thumbnails") {
        setTimeout(() => {
            const active = els.thumbnailsList.querySelector(".thumb-item.active");
            if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
            ensureVisibleThumbnailsRendered();
        }, 0);
    }
}

function ensureVisibleThumbnailsRendered() {
    if (!state.pdf || !state.thumbObserver) return;
    requestAnimationFrame(() => {
        const listRect = els.thumbnailsList.getBoundingClientRect();
        if (listRect.width === 0 || listRect.height === 0) return;
        const margin = 200;
        els.thumbnailsList.querySelectorAll(".thumb-item").forEach(item => {
            if (item.dataset.loaded) return;
            const rect = item.getBoundingClientRect();
            if (rect.bottom > listRect.top - margin && rect.top < listRect.bottom + margin) {
                item.dataset.loaded = "true";
                item.dataset.visible = "true";
                state.thumbObserver.unobserve(item);
                renderThumbnailItem(item, parseInt(item.dataset.page, 10));
            }
        });
    });
}

function toggleSidebar(preferredTab) {
    const isHidden = els.tocPanel.classList.contains("hidden");
    if (isHidden) {
        els.tocPanel.classList.remove("hidden");
        switchSidebarTab(preferredTab);
    } else if (state.activeSidebarTab === preferredTab) {
        els.tocPanel.classList.add("hidden");
    } else {
        switchSidebarTab(preferredTab);
    }
}

// ---- Thumbnails ----
const THUMB_WIDTH = 220;

function initThumbnails() {
    if (state.thumbObserver) {
        state.thumbObserver.disconnect();
        state.thumbObserver = null;
    }

    els.thumbnailsList.innerHTML = "";

    for (let i = 1; i <= state.totalPages; i++) {
        const item = document.createElement("div");
        item.className = "thumb-item";
        item.dataset.page = i;

        const wrapper = document.createElement("div");
        wrapper.className = "thumb-canvas-wrapper";

        const placeholder = document.createElement("div");
        placeholder.className = "thumb-placeholder";
        wrapper.appendChild(placeholder);

        const label = document.createElement("span");
        label.className = "thumb-label";
        label.textContent = i;

        item.appendChild(wrapper);
        item.appendChild(label);

        item.addEventListener("click", () => goToPage(parseInt(item.dataset.page, 10)));

        els.thumbnailsList.appendChild(item);
    }

    state.thumbObserver = new IntersectionObserver(
        (entries, obs) => {
            for (const entry of entries) {
                const item = entry.target;
                if (entry.isIntersecting) {
                    item.dataset.visible = "true";
                    setTimeout(() => {
                        if (item.dataset.visible === "true" && !item.dataset.loaded) {
                            item.dataset.loaded = "true";
                            obs.unobserve(item);
                            renderThumbnailItem(item, parseInt(item.dataset.page, 10));
                        }
                    }, 150);
                } else {
                    item.dataset.visible = "false";
                }
            }
        },
        {
            root: els.thumbnailsList,
            rootMargin: "200px 0px",
            threshold: 0,
        }
    );

    els.thumbnailsList.querySelectorAll(".thumb-item").forEach(item => {
        state.thumbObserver.observe(item);
    });

    updateActiveThumbnail(state.currentPage);
}

async function renderThumbnailItem(item, pageNum) {
    const currentPdf = state.pdf;
    if (!currentPdf) return;

    try {
        const page = await currentPdf.getPage(pageNum);
        if (state.pdf !== currentPdf) return;

        const naturalViewport = page.getViewport({ scale: 1.0 });
        const displayScale = THUMB_WIDTH / naturalViewport.width;
        // Reduce devicePixelRatio factor slightly for performance if needed, but keeping text crisp:
        const renderScale = displayScale * window.devicePixelRatio;

        const renderViewport = page.getViewport({ scale: renderScale });
        const displayViewport = page.getViewport({ scale: displayScale });

        const canvas = document.createElement("canvas");
        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;
        canvas.style.width = displayViewport.width + "px";
        canvas.style.height = displayViewport.height + "px";

        const renderContext = {
            canvasContext: canvas.getContext("2d"),
            viewport: renderViewport,
        };

        await page.render(renderContext).promise;

        const wrapper = item.querySelector(".thumb-canvas-wrapper");
        wrapper.innerHTML = ""; // Clear placeholder
        wrapper.appendChild(canvas);
    } catch (err) {
        console.error(`Thumbnail render error for page ${pageNum}:`, err);
    }
}

function updateActiveThumbnail(pageNum) {
    const prev = els.thumbnailsList.querySelector(".thumb-item.active");
    if (prev) prev.classList.remove("active");

    const next = els.thumbnailsList.querySelector(`.thumb-item[data-page="${pageNum}"]`);
    if (next) {
        next.classList.add("active");
        if (state.activeSidebarTab === "thumbnails" && !els.tocPanel.classList.contains("hidden")) {
            next.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }
}

// ---- Search ----
let searchTimeout = null;

function handleSearch() {
    clearTimeout(searchTimeout);
    const query = els.searchInput.value.trim();

    // Remove existing highlights
    document.querySelectorAll("#text-layer .highlight").forEach((el) => {
        el.classList.remove("highlight");
    });

    if (!query) return;

    searchTimeout = setTimeout(() => {
        const spans = els.textLayer.querySelectorAll("span");
        const lowerQuery = query.toLowerCase();

        for (const span of spans) {
            if (span.textContent.toLowerCase().includes(lowerQuery)) {
                span.classList.add("highlight");
            }
        }
    }, 300);
}

// ---- Keyboard Shortcuts ----
function handleKeyboard(e) {
    // Ignore if typing in input
    if (e.target.tagName === "INPUT") {
        if (e.target === els.pageInput && e.key === "Enter") {
            const page = parseInt(els.pageInput.value, 10);
            if (!isNaN(page)) goToPage(page);
            e.target.blur();
        }
        return;
    }

    switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
            e.preventDefault();
            prevPage();
            break;
        case "ArrowRight":
        case "PageDown":
            e.preventDefault();
            nextPage();
            break;
        case "Home":
            e.preventDefault();
            goToPage(1);
            break;
        case "End":
            e.preventDefault();
            goToPage(state.totalPages);
            break;
        case "+":
        case "=":
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                zoomIn();
            }
            break;
        case "-":
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                zoomOut();
            }
            break;
        case "0":
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                setZoom(1.0);
            }
            break;
        case "o":
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                openFile();
            }
            break;
        case "f":
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                els.searchInput.focus();
            }
            break;
    }
}

// ---- Mouse Wheel Zoom / Page Turn ----
function handleWheel(e) {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
            zoomIn();
        } else {
            zoomOut();
        }
    } else if (e.shiftKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
            prevPage();
        } else {
            nextPage();
        }
    }
}

// ---- Event Listeners ----

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
        e.preventDefault(); // ブラウザのオートスクロール抑制
        isPanning  = true;
        startX     = e.clientX;
        startY     = e.clientY;
        scrollLeft = container.scrollLeft;
        scrollTop  = container.scrollTop;
        container.classList.add('is-panning');
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        e.preventDefault(); // パン中テキスト選択を抑制
        container.scrollLeft = scrollLeft - (e.clientX - startX);
        container.scrollTop  = scrollTop  - (e.clientY - startY);
    });

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

els.btnOpen.addEventListener("click", openFile);
els.btnWelcomeOpen.addEventListener("click", openFile);
els.btnPrev.addEventListener("click", prevPage);
els.btnNext.addEventListener("click", nextPage);
els.btnZoomIn.addEventListener("click", zoomIn);
els.btnZoomOut.addEventListener("click", zoomOut);
els.btnFitWidth.addEventListener("click", fitWidth);
els.btnToc.addEventListener("click", () => toggleSidebar("toc"));
els.btnThumbnails.addEventListener("click", () => toggleSidebar("thumbnails"));
els.btnTocClose.addEventListener("click", () => els.tocPanel.classList.add("hidden"));
els.sidebarTabs.forEach(tab => tab.addEventListener("click", () => switchSidebarTab(tab.dataset.tab)));
els.searchInput.addEventListener("input", handleSearch);

document.addEventListener("keydown", handleKeyboard);
els.viewerContainer.addEventListener("wheel", handleWheel, { passive: false });

els.pageInput.addEventListener("change", () => {
    const page = parseInt(els.pageInput.value, 10);
    if (!isNaN(page)) goToPage(page);
});

// Drag & drop support
document.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
});

document.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith(".pdf")) {
        els.statusInfo.textContent = "読み込み中...";
        await openFileFromData(new Uint8Array(await file.arrayBuffer()), file.name);
    }
});

// ---- 起動引数 / ファイルダブルクリックで開く ----
// Rust側から "open-pdf" イベントでパスが送信されてくる（Tauri環境のみ）
if (window.__TAURI_INTERNALS__) {
    try {
        await listen("open-pdf", (event) => {
            const filePath = event.payload;
            if (filePath && filePath.toLowerCase().endsWith(".pdf")) {
                openFileByPath(filePath);
            }
        });
    } catch (err) {
        console.error("Tauriイベントリスナーの登録に失敗しました:", err);
    }
}
