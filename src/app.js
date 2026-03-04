/* ============================================
   PDF Viewer - Application Logic
   ============================================ */

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
// import { readFile } from "@tauri-apps/plugin-fs"; 
import { listen } from "@tauri-apps/api/event";
import * as pdfjsLib from "pdfjs-dist";

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
).toString();

// ---- State ----
const BASE_RENDER_WIDTH = 800;
const state = {
    pdf: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.0,
    filePath: null,
    rendering: false,
    pendingPage: null,
    outline: null,
    currentReqId: null,
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
    btnTocClose: document.getElementById("btn-toc-close"),
    tabToc: document.getElementById("tab-toc"),
    tabThumbnails: document.getElementById("tab-thumbnails"),
    pageInput: document.getElementById("page-input"),
    pageTotal: document.getElementById("page-total"),
    zoomLevel: document.getElementById("zoom-level"),
    searchInput: document.getElementById("search-input"),
    welcomeScreen: document.getElementById("welcome-screen"),
    pdfContainer: document.getElementById("pdf-container"),
    canvas: document.getElementById("pdf-canvas"),
    textLayer: document.getElementById("text-layer"),
    tocPanel: document.getElementById("toc-panel"),
    tocList: document.getElementById("toc-list"),
    thumbnailList: document.getElementById("thumbnail-list"),
    fileName: document.getElementById("file-name"),
    statusInfo: document.getElementById("status-info"),
    viewerContainer: document.getElementById("viewer-container"),
};

// ---- PDF Loading ----

/** ファイルパスを直接渡してPDFを読み込む共通処理 */
async function openFileByPath(filePath) {
    try {
        els.statusInfo.textContent = "読み込み中...";
        state.filePath = filePath;

        // 1. RustバックエンドでPDFをロードし、ページ数を取得
        const totalPages = await invoke('load_pdf', { path: filePath });
        state.totalPages = totalPages;
        state.currentPage = 1;
        state.scale = 1.0;

        // 2. メタデータ（目次など）のために PDF.js でもロード（convertFileSrcを使用）
        try {
            const assetUrl = convertFileSrc(filePath);
            const loadingTask = pdfjsLib.getDocument(assetUrl);
            state.pdf = await loadingTask.promise;
            loadOutline();
        } catch (pdfjsErr) {
            console.warn("PDF.js metadata load failed, TOC/Text search might be unavailable:", pdfjsErr);
            state.pdf = null;
        }

        // Update UI
        els.pageTotal.textContent = state.totalPages;
        els.pageInput.max = state.totalPages;
        const pathParts = filePath.replace(/\\/g, "/").split("/");
        els.fileName.textContent = pathParts[pathParts.length - 1];

        // Show PDF, hide welcome
        els.welcomeScreen.style.display = "none";
        els.pdfContainer.classList.remove("hidden");

        // Enable nav buttons
        updateNavButtons();
        updateZoomDisplay();

        // Render first page
        await renderPage(state.currentPage);

        els.statusInfo.textContent = "";
    } catch (err) {
        console.error("Failed to open PDF:", err);
        els.statusInfo.textContent = `エラー: ファイルを開けませんでした (${err})`;
    }
}


/** ダイアログでファイルを選択して開く */
async function openFile() {
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
}

// ---- Page Rendering ----
async function renderPage(pageNum) {
    if (!state.filePath) return;

    // キャンセル通知（前のリクエストがあれば）
    if (state.currentReqId) {
        invoke('cancel_render', { reqId: state.currentReqId });
    }

    const reqId = `req_${pageNum}_${Date.now()}`;
    state.currentReqId = reqId;
    state.currentPage = pageNum;
    els.pageInput.value = pageNum;
    updateNavButtons();

    try {
        // Rustバックエンドから生のRGBAデータを取得 (Tauri IPC Response)
        // pageNumは0オリジンとして送信
        const renderWidth = Math.round(BASE_RENDER_WIDTH * state.scale);
        const rawRgbaData = await invoke('request_render', {
            pageNum: pageNum - 1,
            reqId: reqId,
            width: renderWidth
        });

        // 応答を待っている間に別のリクエストが走っていたら破棄
        if (state.currentReqId !== reqId) return;

        // invoke() が返す IPC Response は ArrayBuffer なので .byteLength を使う
        // (.length は ArrayBuffer には存在しないため undefined になる)
        const width = renderWidth;
        const byteLen = rawRgbaData.byteLength ?? rawRgbaData.length;
        const height = Math.floor(byteLen / 4 / width);

        if (height <= 0) {
            console.error("Render error: invalid height calculated. byteLen=", byteLen, "rawRgbaData=", rawRgbaData);
            els.statusInfo.textContent = "描画エラー: データサイズ不正";
            return;
        }

        const canvas = els.canvas;
        const ctx = canvas.getContext('2d');
        canvas.width = width;
        canvas.height = height;

        // ArrayBuffer または number[] どちらでも対応
        const uint8 = rawRgbaData instanceof ArrayBuffer
            ? new Uint8ClampedArray(rawRgbaData)
            : new Uint8ClampedArray(rawRgbaData);

        const imageData = new ImageData(uint8, width, height);
        ctx.putImageData(imageData, 0, 0);

        // テキストレイヤーの更新 (PDF.jsを併用、失敗しても描画には影響しない)
        if (state.pdf) {
            updateTextLayer(pageNum);
        }

        // サムネイルのアクティブ状態を同期
        syncThumbnailActive(pageNum);

        els.statusInfo.textContent = `${pageNum} / ${state.totalPages} ページ`;
    } catch (err) {
        if (state.currentReqId === reqId) {
            console.error("Render error:", err);
            els.statusInfo.textContent = `描画エラー: ${err}`;
        }
    }
}

async function updateTextLayer(pageNum) {
    try {
        const page = await state.pdf.getPage(pageNum);
        const width = Math.round(BASE_RENDER_WIDTH * state.scale);
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });

        els.textLayer.innerHTML = "";
        const textContent = await page.getTextContent();

        for (const item of textContent.items) {
            const span = document.createElement("span");
            const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);

            span.style.left = tx[4] + "px";
            span.style.top = (tx[5] - fontSize) + "px";
            span.style.fontSize = fontSize + "px";
            span.style.fontFamily = item.fontName || "sans-serif";
            span.textContent = item.str;
            els.textLayer.appendChild(span);
        }
    } catch (err) {
        console.error("Text layer error:", err);
    }
}


// ---- Navigation ----
function goToPage(pageNum) {
    // state.pdf (PDF.js) がなくてもRust側でレンダリングできるため totalPages でチェック
    if (state.totalPages === 0) return;
    const page = Math.max(1, Math.min(pageNum, state.totalPages));
    if (page !== state.currentPage) {
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
    const noFile = state.totalPages === 0;
    els.btnPrev.disabled = noFile || state.currentPage <= 1;
    els.btnNext.disabled = noFile || state.currentPage >= state.totalPages;
}

// ---- Zoom ----
function setZoom(newScale) {
    state.scale = Math.max(0.25, Math.min(5.0, newScale));
    updateZoomDisplay();
    // filePath があればRust側で再レンダリング可能
    if (state.filePath) {
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
    if (state.totalPages === 0) return;
    // PDF.js が利用可能な場合は正確な幅を計算、そうでなければデフォルト幅を使用
    if (state.pdf) {
        const page = await state.pdf.getPage(state.currentPage);
        const viewport = page.getViewport({ scale: 1.0 });
        const containerWidth = els.viewerContainer.clientWidth - 80;
        const newScale = containerWidth / viewport.width;
        setZoom(newScale);
    } else {
        // PDF.js なしでも幅調整：Rustは基準幅比率で計算
        const containerWidth = els.viewerContainer.clientWidth - 80;
        const newScale = containerWidth / BASE_RENDER_WIDTH;
        setZoom(newScale);
    }
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

function toggleToc() {
    els.tocPanel.classList.toggle("hidden");
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

// ---- Mouse Wheel Zoom & Page Turn ----
function handleWheel(e) {
    if (e.ctrlKey || e.metaKey) {
        // Ctrl+ホイール: ズーム
        e.preventDefault();
        if (e.deltaY < 0) {
            zoomIn();
        } else {
            zoomOut();
        }
    } else if (e.shiftKey) {
        // Shift+ホイール: ページモード
        e.preventDefault();
        if (e.deltaY < 0 || e.deltaX < 0) {
            prevPage();
        } else {
            nextPage();
        }
    }
}

// ---- Event Listeners ----
els.btnOpen.addEventListener("click", openFile);
els.btnWelcomeOpen.addEventListener("click", openFile);
els.btnPrev.addEventListener("click", prevPage);
els.btnNext.addEventListener("click", nextPage);
els.btnZoomIn.addEventListener("click", zoomIn);
els.btnZoomOut.addEventListener("click", zoomOut);
els.btnFitWidth.addEventListener("click", fitWidth);
els.btnToc.addEventListener("click", toggleToc);
els.btnTocClose.addEventListener("click", toggleToc);
els.searchInput.addEventListener("input", handleSearch);
els.tabToc.addEventListener("click", () => switchSidebarTab("toc"));
els.tabThumbnails.addEventListener("click", () => switchSidebarTab("thumbnails"));

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
    // Tauri might pass file paths differently; this is a fallback
});

// ---- Thumbnail Sidebar ----
let thumbnailAbortController = null;

async function buildThumbnails() {
    if (state.totalPages === 0) return;

    // 前回のサムネイル生成をキャンセル
    if (thumbnailAbortController) thumbnailAbortController.abort();
    thumbnailAbortController = new AbortController();
    const { signal } = thumbnailAbortController;

    els.thumbnailList.innerHTML = "";

    // 先にプレースホルダーを作成してページ数を表示
    for (let i = 1; i <= state.totalPages; i++) {
        const item = document.createElement("div");
        item.className = "thumbnail-item" + (i === state.currentPage ? " active" : "");
        item.dataset.page = i;
        item.addEventListener("click", () => goToPage(i));

        const placeholder = document.createElement("div");
        placeholder.className = "thumbnail-loading";
        placeholder.textContent = `${i} ページ読み込み中...`;

        const pageNum = document.createElement("span");
        pageNum.className = "thumbnail-page-num";
        pageNum.textContent = i;

        item.appendChild(placeholder);
        item.appendChild(pageNum);
        els.thumbnailList.appendChild(item);
    }

    // 1枚ずつ順番にレンダリング（並列化せずキャンセル可能）
    for (let i = 1; i <= state.totalPages; i++) {
        if (signal.aborted) break;

        try {
            const THUMB_WIDTH = 200;
            const reqId = `thumb_${i}_${Date.now()}`;
            const rawRgbaData = await invoke('request_render', {
                pageNum: i - 1,
                reqId,
                width: THUMB_WIDTH
            });

            if (signal.aborted) break;

            const byteLen = rawRgbaData.byteLength ?? rawRgbaData.length;
            const height = Math.floor(byteLen / 4 / THUMB_WIDTH);
            if (height <= 0) continue;

            const thumbCanvas = document.createElement("canvas");
            thumbCanvas.className = "thumbnail-canvas";
            thumbCanvas.width = THUMB_WIDTH;
            thumbCanvas.height = height;
            const ctx = thumbCanvas.getContext("2d");

            const uint8 = rawRgbaData instanceof ArrayBuffer
                ? new Uint8ClampedArray(rawRgbaData)
                : new Uint8ClampedArray(rawRgbaData);

            ctx.putImageData(new ImageData(uint8, THUMB_WIDTH, height), 0, 0);

            // プレースホルダーをキャンバスに差し替え
            const item = els.thumbnailList.querySelector(`[data-page="${i}"]`);
            if (item) {
                const placeholder = item.querySelector(".thumbnail-loading");
                if (placeholder) item.replaceChild(thumbCanvas, placeholder);
            }
        } catch (err) {
            if (!signal.aborted) console.warn(`Thumbnail render failed for page ${i}:`, err);
        }
    }
}

/** 現在ページのサムネイルアクティブ状態を更新 */
function syncThumbnailActive(pageNum) {
    const items = els.thumbnailList.querySelectorAll(".thumbnail-item");
    items.forEach(item => {
        const isActive = parseInt(item.dataset.page) === pageNum;
        item.classList.toggle("active", isActive);
        if (isActive) {
            item.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    });
}

// ---- Sidebar Tab Switch ----
function switchSidebarTab(tab) {
    const isThumb = tab === "thumbnails";
    els.tabToc.classList.toggle("active", !isThumb);
    els.tabThumbnails.classList.toggle("active", isThumb);
    els.tocList.classList.toggle("hidden", isThumb);
    els.thumbnailList.classList.toggle("hidden", !isThumb);

    // 初回タブ表示時にサムネイルを生成
    if (isThumb && els.thumbnailList.children.length === 0) {
        buildThumbnails();
    }
}
// Rust側から "open-pdf" イベントでパスが送信されてくる
await listen("open-pdf", (event) => {
    const filePath = event.payload;
    if (filePath && filePath.toLowerCase().endsWith(".pdf")) {
        openFileByPath(filePath);
    }
});
