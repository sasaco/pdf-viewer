/**
 * book-edge.test.js — bookEdge.js の単体テスト
 *
 * 境界条件（0/1/2/100/300 ページ）を中心に検証。
 * 実行: npm test
 */

import { describe, it, expect } from "vitest";
import {
    calcEdgeCount,
    calcMaxEdgePx,
    getHighlightedIndex,
    getRectWidths,
    calcCumulative,
    getPageForIndex,
    EDGE_INTERVAL,
    HOVER_MULT,
    HIGHLIGHT_MULT,
    EDGE_SAFE_MARGIN,
} from "../src/bookEdge.js";

// ============================================================
// calcEdgeCount
// ============================================================

describe("calcEdgeCount", () => {
    it("0ページ → 0", () => {
        expect(calcEdgeCount(0)).toBe(0);
    });

    it("1ページ → 0", () => {
        expect(calcEdgeCount(1)).toBe(0);
    });

    it("2ページ → 1", () => {
        // number=1, floor(2/1)-1 = 1
        expect(calcEdgeCount(2)).toBe(1);
    });

    it("50ページ → 49", () => {
        // number=1, floor(50/1)-1 = 49
        expect(calcEdgeCount(50)).toBe(49);
    });

    it("100ページ → 49", () => {
        // number=2, floor(100/2)-1 = 49
        expect(calcEdgeCount(100)).toBe(49);
    });

    it("300ページ → 49", () => {
        // number=6, floor(300/6)-1 = 49
        expect(calcEdgeCount(300)).toBe(49);
    });

    it("ページ数が増えても count は単調非減少", () => {
        const counts = [1, 2, 10, 50, 100, 200, 300].map(calcEdgeCount);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
    });
});

// ============================================================
// calcMaxEdgePx
// ============================================================

describe("calcMaxEdgePx", () => {
    it("1ページ → EDGE_SAFE_MARGIN だけ返す", () => {
        expect(calcMaxEdgePx(1)).toBe(EDGE_SAFE_MARGIN);
    });

    it("ページ数が増えると px も増える（単調非減少）", () => {
        const values = [1, 2, 10, 50, 100, 300].map(calcMaxEdgePx);
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
        }
    });

    it("100ページ時の値が EDGE_SAFE_MARGIN より大きい", () => {
        expect(calcMaxEdgePx(100)).toBeGreaterThan(EDGE_SAFE_MARGIN);
    });
});

// ============================================================
// getHighlightedIndex
// ============================================================

describe("getHighlightedIndex", () => {
    it("1ページのみ → -1（ハイライト無効）", () => {
        expect(getHighlightedIndex(1, 1, 0)).toBe(-1);
    });

    it("count=0 → -1", () => {
        expect(getHighlightedIndex(1, 100, 0)).toBe(-1);
    });

    it("先頭ページ(1)は index 0", () => {
        expect(getHighlightedIndex(1, 100, 49)).toBe(0);
    });

    it("最終ページ(100)は index count-1", () => {
        const count = calcEdgeCount(100);
        expect(getHighlightedIndex(100, 100, count)).toBe(count - 1);
    });

    it("中間ページは 0 〜 count-1 の範囲内", () => {
        const count = calcEdgeCount(100);
        for (let p = 1; p <= 100; p++) {
            const idx = getHighlightedIndex(p, 100, count);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThanOrEqual(count - 1);
        }
    });

    it("currentPage が増えると highlightedIndex は単調非減少", () => {
        const count = calcEdgeCount(100);
        let prev = -1;
        for (let p = 1; p <= 100; p++) {
            const idx = getHighlightedIndex(p, 100, count);
            expect(idx).toBeGreaterThanOrEqual(prev);
            prev = idx;
        }
    });
});

// ============================================================
// getRectWidths
// ============================================================

describe("getRectWidths", () => {
    it("ホバー・ハイライトなし → 全て EDGE_INTERVAL", () => {
        const widths = getRectWidths(5, -1, -1);
        expect(widths).toHaveLength(5);
        widths.forEach((w) => expect(w).toBe(EDGE_INTERVAL));
    });

    it("ホバー中のインデックスは EDGE_INTERVAL * HOVER_MULT", () => {
        const widths = getRectWidths(5, 2, -1);
        expect(widths[2]).toBe(EDGE_INTERVAL * HOVER_MULT);
        expect(widths[0]).toBe(EDGE_INTERVAL);
        expect(widths[4]).toBe(EDGE_INTERVAL);
    });

    it("ハイライト中のインデックスは EDGE_INTERVAL * HIGHLIGHT_MULT", () => {
        const widths = getRectWidths(5, -1, 3);
        expect(widths[3]).toBe(EDGE_INTERVAL * HIGHLIGHT_MULT);
        expect(widths[0]).toBe(EDGE_INTERVAL);
    });

    it("ハイライト > ホバー（同インデックスならハイライト優先）", () => {
        const widths = getRectWidths(5, 2, 2);
        expect(widths[2]).toBe(EDGE_INTERVAL * HIGHLIGHT_MULT);
    });

    it("count=0 → 空配列", () => {
        expect(getRectWidths(0, -1, -1)).toHaveLength(0);
    });
});

// ============================================================
// calcCumulative
// ============================================================

describe("calcCumulative", () => {
    it("空配列 → 空配列", () => {
        expect(calcCumulative([])).toEqual([]);
    });

    it("[5, 5, 5] → [5, 10, 15]", () => {
        expect(calcCumulative([5, 5, 5])).toEqual([5, 10, 15]);
    });

    it("[5, 20, 5] → [5, 25, 30]", () => {
        expect(calcCumulative([5, 20, 5])).toEqual([5, 25, 30]);
    });

    it("最後の要素は配列の合計に等しい", () => {
        const widths = [5, 20, 40, 5];
        const cum = calcCumulative(widths);
        const sum = widths.reduce((a, b) => a + b, 0);
        expect(cum[cum.length - 1]).toBe(sum);
    });
});

// ============================================================
// getPageForIndex
// ============================================================

describe("getPageForIndex", () => {
    it("totalPages=1 → 常に 1 を返す", () => {
        expect(getPageForIndex(0, 0, 1, 1, 0)).toBe(1);
    });

    it("idx === highlightedIdx → currentPage を返す", () => {
        const count = calcEdgeCount(100);
        const highlighted = getHighlightedIndex(50, 100, count);
        expect(getPageForIndex(highlighted, highlighted, 50, 100, count)).toBe(50);
    });

    it("戻り値は常に [1, totalPages] の範囲内（100ページ）", () => {
        const totalPages = 100;
        const count = calcEdgeCount(totalPages);
        const highlighted = getHighlightedIndex(50, totalPages, count);
        for (let i = 0; i < count; i++) {
            const page = getPageForIndex(i, highlighted, 50, totalPages, count);
            expect(page).toBeGreaterThanOrEqual(1);
            expect(page).toBeLessThanOrEqual(totalPages);
        }
    });

    it("戻り値は常に [1, totalPages] の範囲内（300ページ）", () => {
        const totalPages = 300;
        const count = calcEdgeCount(totalPages);
        const highlighted = getHighlightedIndex(150, totalPages, count);
        for (let i = 0; i < count; i++) {
            const page = getPageForIndex(i, highlighted, 150, totalPages, count);
            expect(page).toBeGreaterThanOrEqual(1);
            expect(page).toBeLessThanOrEqual(totalPages);
        }
    });

    it("インデックス 0 は先頭付近のページ、count-1 は末尾付近のページ", () => {
        const totalPages = 100;
        const count = calcEdgeCount(totalPages);
        const highlighted = getHighlightedIndex(50, totalPages, count);
        const first = getPageForIndex(0, highlighted, 50, totalPages, count);
        const last = getPageForIndex(count - 1, highlighted, 50, totalPages, count);
        expect(first).toBeLessThanOrEqual(last);
    });

    it("count=0 → 1 を返す", () => {
        expect(getPageForIndex(0, -1, 5, 100, 0)).toBe(1);
    });
});
