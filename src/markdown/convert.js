/**
 * 共通 dispatcher。フェーズ1 では PDF のみ。
 * フェーズ2 で同 API を維持したまま `invoke('convert_to_markdown', { path })` 分岐を追加する。
 *
 * 公開 API（フェーズ1 で確定）:
 *   convertToMarkdown(file: { name?, path?, arrayBuffer? }, deps?): Promise<string>
 *     - 拡張子 `.pdf` 以外は `Error('format not supported in phase 1')` を throw
 *     - arrayBuffer 必須（フェーズ1）
 *
 *   convertPdfDocumentToMarkdown(pdfProxy, deps?): Promise<string>
 *     - 既にロード済みの PDFDocumentProxy を直接 Markdown 化する補助 API。
 *     - app.js のように state.pdf を持っている呼び出し側はこちらを使う。
 *     - フェーズ2 でもシグネチャは維持されるため、UI 側の分岐点はこの 1 関数に集約される。
 *
 * Precondition: ブラウザ／Tauri 環境で利用する場合は、呼び出し側で
 *   `pdfjsLib.GlobalWorkerOptions.workerSrc = ...`
 * を設定済みであること（vite/Tauri 起動時に app.js が実施）。
 */

import { pdfToMarkdown as defaultPdfToMarkdown } from "./pdfToMarkdown.js";

function getExtension(file) {
  const ref = file?.name || file?.path || "";
  const m = ref.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

async function defaultLoadPdf(arrayBuffer) {
  // Precondition: 呼び出し側で workerSrc を設定済みであること。
  const pdfjs = await import("pdfjs-dist");
  try {
    return await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  } catch (err) {
    // PDF.js は PasswordException, InvalidPDFException, MissingPDFException などを投げる
    const name = err?.name || "Error";
    const msg = err?.message || String(err);
    if (name === "PasswordException") {
      throw new Error("PDF is password-protected");
    }
    if (name === "InvalidPDFException") {
      throw new Error(`Invalid PDF: ${msg}`);
    }
    throw new Error(`Failed to load PDF: ${msg}`);
  }
}

/** options を pdfToMarkdown に渡すための共通 picker。 */
function rendererOptions(deps) {
  return {
    signal: deps.signal,
    maxPages: deps.maxPages,
    onPageError: deps.onPageError,
  };
}

/**
 * @param {{ name?: string, path?: string, arrayBuffer?: ArrayBuffer }} file
 * @param {{ _loadPdf?: Function, _pdfToMarkdown?: Function, signal?: AbortSignal,
 *           maxPages?: number, onPageError?: Function }} [deps]
 * @returns {Promise<string>}
 */
export async function convertToMarkdown(file, deps = {}) {
  const ext = getExtension(file);
  if (ext !== "pdf") {
    throw new Error("format not supported in phase 1");
  }
  if (!file.arrayBuffer) {
    throw new Error("convertToMarkdown: no data (arrayBuffer is required)");
  }
  const loadPdf = deps._loadPdf || defaultLoadPdf;
  const renderer = deps._pdfToMarkdown || defaultPdfToMarkdown;

  const pdf = await loadPdf(file.arrayBuffer);
  try {
    return await renderer(pdf, rendererOptions(deps));
  } finally {
    if (typeof pdf.destroy === "function") {
      try {
        await pdf.destroy();
      } catch (e) {
        console.warn("convertToMarkdown: pdf.destroy failed:", e?.message ?? e);
      }
    }
  }
}

/**
 * 既にロード済みの PDFDocumentProxy を Markdown 化する補助 API（UI 側用）。
 * destroy はしない（呼び出し側が PDF ライフサイクルを管理）。
 *
 * @param {object} pdfProxy
 * @param {{ _pdfToMarkdown?: Function, signal?: AbortSignal,
 *           maxPages?: number, onPageError?: Function }} [deps]
 */
export async function convertPdfDocumentToMarkdown(pdfProxy, deps = {}) {
  const renderer = deps._pdfToMarkdown || defaultPdfToMarkdown;
  return await renderer(pdfProxy, rendererOptions(deps));
}

export default convertToMarkdown;
