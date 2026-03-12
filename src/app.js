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

        // Read file bytes via Tauri fs plugin
        const fileBytes = await readFile(filePath);

        // Load PDF with PDF.js
        const typedArray = new Uint8Array(fileBytes);
        const loadingTask = pdfjsLib.getDocument({ data: typedArray });
        const pdf = await loadingTask.promise;

        state.pdf = pdf;
        state.totalPages = pdf.numPages;
        state.currentPage = 1;
        state.scale = 1.0;

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

        // Load outline
        loadOutline();

        // Render first page
        await renderPage(state.currentPage);

        els.statusInfo.textContent = "";
    } catch (err) {
        console.error("Failed to open PDF:", err);
        els.statusInfo.textContent = "エラー: ファイルを開けませんでした";
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
    if (!state.pdf) return;

    if (state.rendering) {
        state.pendingPage = pageNum;
        return;
    }

    state.rendering = true;
    state.currentPage = pageNum;
    els.pageInput.value = pageNum;
    updateNavButtons();

    try {
        const page = await state.pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale * window.devicePixelRatio });
        const displayViewport = page.getViewport({ scale: state.scale });

        const canvas = els.canvas;
        const context = canvas.getContext("2d");
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        canvas.style.width = displayViewport.width + "px";
        canvas.style.height = displayViewport.height + "px";

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

// ---- 起動引数 / ファイルダブルクリックで開く ----
// Rust側から "open-pdf" イベントでパスが送信されてくる
await listen("open-pdf", (event) => {
    const filePath = event.payload;
    if (filePath && filePath.toLowerCase().endsWith(".pdf")) {
        openFileByPath(filePath);
    }
});
