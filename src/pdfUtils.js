/* ============================================
   PDF Viewer - Pure Utility Functions
   (テスト可能な純粋関数として切り出し)
   ============================================ */

/**
 * ファイルパスからファイル名を取得する
 * @param {string} filePath
 * @returns {string}
 */
export function extractFileName(filePath) {
    return filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
}

/**
 * ページ番号を有効範囲に収めてクランプする
 * @param {number} page
 * @param {number} totalPages
 * @returns {number}
 */
export function clampPage(page, totalPages) {
    return Math.max(1, Math.min(page, totalPages));
}

/**
 * スケール値を有効範囲（0.25〜5.0）に収める
 * @param {number} newScale
 * @returns {number}
 */
export function clampScale(newScale) {
    return Math.max(0.25, Math.min(5.0, newScale));
}

/**
 * スケールをパーセント文字列に変換する
 * @param {number} scale
 * @returns {string}
 */
export function scaleToPercent(scale) {
    return Math.round(scale * 100) + "%";
}

/**
 * コンテナ幅とページ幅からフィット幅スケールを計算する
 * @param {number} containerWidth
 * @param {number} pageWidth
 * @param {number} padding デフォルト80px
 * @returns {number}
 */
export function calcFitWidthScale(containerWidth, pageWidth, padding = 80) {
    return (containerWidth - padding) / pageWidth;
}

/**
 * ナビゲーションボタンの無効状態を計算する
 * @param {object|null} pdf
 * @param {number} currentPage
 * @param {number} totalPages
 * @returns {{ prevDisabled: boolean, nextDisabled: boolean }}
 */
export function calcNavDisabled(pdf, currentPage, totalPages) {
    return {
        prevDisabled: !pdf || currentPage <= 1,
        nextDisabled: !pdf || currentPage >= totalPages,
    };
}
