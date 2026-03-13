/**
 * bookEdge.js — ページ厚み表現の純粋計算関数
 *
 * DOM や Konva に依存しない純粋関数群。
 * テスト容易性と app.js の責務分離のために分離。
 */

export const EDGE_INTERVAL = 5;     // 通常時の 1 枚あたりズレ幅 (px)
export const HOVER_MULT = 4;        // ホバー時の幅倍率
export const HIGHLIGHT_MULT = 8;    // ハイライト時の幅倍率
export const WRAP_NUM = 50;         // count 計算で使うページ数のまとまり
export const EDGE_SAFE_MARGIN = 24; // Stage パディング余白

/**
 * 描画する背景矩形の枚数を返す。
 * @param {number} totalPages
 * @returns {number}
 */
export function calcEdgeCount(totalPages) {
    if (totalPages <= 1) return 0;
    const number = Math.max(1, Math.ceil(totalPages / WRAP_NUM));
    return Math.max(0, Math.floor(totalPages / number) - 1);
}

/**
 * エッジ表示に必要な最大ピクセル幅を返す。
 * CANVAS_PAD_TOP / CANVAS_PAD_RIGHT の計算に使用。
 * @param {number} totalPages
 * @returns {number}
 */
export function calcMaxEdgePx(totalPages) {
    const count = calcEdgeCount(totalPages);
    if (count <= 0) return EDGE_SAFE_MARGIN;
    const base = count * EDGE_INTERVAL;
    const extra = EDGE_INTERVAL * ((HIGHLIGHT_MULT - 1) + (HOVER_MULT - 1));
    return base + extra + EDGE_SAFE_MARGIN;
}

/**
 * 現在ページがスタック内のどのインデックスに対応するかを返す。
 * totalPages <= 1 や count <= 0 の場合は -1（ハイライト無効）。
 * @param {number} currentPage  1-based
 * @param {number} totalPages
 * @param {number} count        calcEdgeCount の戻り値
 * @returns {number}
 */
export function getHighlightedIndex(currentPage, totalPages, count) {
    if (totalPages <= 1 || count <= 0) return -1;
    const rel = (currentPage - 1) / (totalPages - 1);
    return Math.min(count - 1, Math.floor(rel * count));
}

/**
 * 各矩形のズレ幅（px）を配列で返す。
 * @param {number} count
 * @param {number} hoveredIdx   ホバー中のインデックス（なければ -1）
 * @param {number} highlightedIdx  ハイライト対象のインデックス（なければ -1）
 * @returns {number[]}
 */
export function getRectWidths(count, hoveredIdx, highlightedIdx) {
    return Array.from({ length: count }, (_, i) => {
        if (i === highlightedIdx) return EDGE_INTERVAL * HIGHLIGHT_MULT;
        if (i === hoveredIdx)     return EDGE_INTERVAL * HOVER_MULT;
        return EDGE_INTERVAL;
    });
}

/**
 * 幅の配列から累積値の配列を返す。
 * cumulative[i] はインデックス 0〜i の幅の合計。
 * @param {number[]} widths
 * @returns {number[]}
 */
export function calcCumulative(widths) {
    let cum = 0;
    return widths.map((w) => (cum += w));
}

/**
 * エッジ上のインデックスからクリック遷移先のページ番号を返す。
 * ハイライト帯クリック時は現在ページを返す（意図しないジャンプを防止）。
 * @param {number} idx
 * @param {number} highlightedIdx
 * @param {number} currentPage  1-based
 * @param {number} totalPages
 * @param {number} count
 * @returns {number}  1-based ページ番号
 */
export function getPageForIndex(idx, highlightedIdx, currentPage, totalPages, count) {
    if (totalPages <= 1 || count <= 0) return 1;
    if (idx === highlightedIdx) return currentPage;
    if (count === 1) return currentPage;

    const rel = idx / (count - 1);
    const target = 1 + Math.round(rel * (totalPages - 1));
    return Math.max(1, Math.min(target, totalPages));
}
