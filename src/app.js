/* ============================================
   PDF Viewer - Application Logic
   ============================================ */

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import * as pdfjsLib from "pdfjs-dist";

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
).toString();

// ---- Book Depth Config ----
const BOOK_DEPTH = {
    pagesPerLayer: 50,
    maxLayers: 6,
    normalWidth: 5,   // px
    highlightMul: 8,  // P.1ハイライト層: normalWidth の8倍
};

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

        // Load outline
        loadOutline();

        // Initialize thumbnails AFTER basic render setup
        await renderPage(state.currentPage);
        updateBookEdges();
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
            span.style.left = tx[4] + 24 + "px"; // 24px padding offset
            span.style.top = tx[5] - fontSize + 24 + "px";
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
        renderPage(page);
        updateBookEdges();
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

// ---- Book Depth ----
function calcNumLayers(currentPage, totalPages) {
    const remaining = totalPages - currentPage;
    return Math.min(BOOK_DEPTH.maxLayers, Math.ceil(remaining / BOOK_DEPTH.pagesPerLayer));
}

// 層インデックス → ページ番号（全レイヤーが [2, numPages] を均等に表現）
function getLayerPageNumber(layerIndex, numLayers, numPages) {
    if (numLayers <= 1) return numPages;
    return Math.min(numPages, Math.round(2 + (layerIndex / (numLayers - 1)) * (numPages - 2)));
}

// P.1 がどの層かを算出（currentPage > 1 の時のみ意味を持つ）
function getHighlightedLayerIndex(currentPage, numPages, numLayers) {
    if (currentPage <= 1 || numLayers <= 0) return -1;
    return Math.min(
        Math.floor((currentPage - 2) / (numPages - 2) * numLayers),
        numLayers - 1
    );
}

function updateBookEdges() {
    if (!state.pdf) return;
    const wrapper = els.bookDepthWrapper;
    
    // 現在のキャンバス要素を退避し、ラッパーの中身を空にしてから戻す（安全で確実なクリア）
    const canvas = els.canvas;
    wrapper.innerHTML = '';
    wrapper.appendChild(canvas);

    const numLayers = calcNumLayers(state.currentPage, state.totalPages);
    if (numLayers === 0) return;

    const highlightIdx = getHighlightedLayerIndex(state.currentPage, state.totalPages, numLayers);
    let cumLeft = 0;

    for (let i = 0; i < numLayers; i++) {
        const isHighlighted = (i === highlightIdx);
        const w = isHighlighted
            ? BOOK_DEPTH.normalWidth * BOOK_DEPTH.highlightMul
            : BOOK_DEPTH.normalWidth;
        const pageNum = isHighlighted ? 1 : getLayerPageNumber(i, numLayers, state.totalPages);

        const layer = document.createElement('div');
        layer.className = 'page-edge-layer' + (isHighlighted ? ' highlighted' : '');
        layer.style.left = `calc(100% + ${cumLeft}px)`;
        layer.style.width = w + 'px';
        layer.dataset.targetPage = pageNum;
        layer.title = `P. ${pageNum}`;

        wrapper.appendChild(layer);
        cumLeft += w;
    }
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
    const containerWidth = els.viewerContainer.clientWidth - 80; // padding
    const newScale = containerWidth / viewport.width;
    setZoom(newScale);
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

// Book depth: イベント委譲で一度だけ登録
els.bookDepthWrapper.addEventListener('click', (e) => {
    const edge = e.target.closest('.page-edge-layer');
    if (!edge || !edge.dataset.targetPage) return; // targetPageが無い場合は無視
    
    const pageNum = Number(edge.dataset.targetPage);
    if (!isNaN(pageNum)) {
        goToPage(pageNum);
    }
});

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
