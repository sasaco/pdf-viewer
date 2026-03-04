/**
 * PDF Viewer テストスイート
 *
 * テスト対象:
 *  1. 純粋ユーティリティ関数（pdfUtils.js）
 *  2. PDF.js を使った tests/test.pdf のインテグレーション
 *
 * 実行: npm test
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
    extractFileName,
    clampPage,
    clampScale,
    scaleToPercent,
    calcFitWidthScale,
    calcNavDisabled,
} from "../src/pdfUtils.js";

// PDF.js (Node環境対応ビルド)
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

// ============================================================
// 1. ユーティリティ関数 - 単体テスト
// ============================================================

describe("extractFileName", () => {
    it("Windowsパス（バックスラッシュ）からファイル名を取得できる", () => {
        expect(extractFileName("C:\\Users\\sasai\\Documents\\sample.pdf")).toBe("sample.pdf");
    });

    it("Unixパス（スラッシュ）からファイル名を取得できる", () => {
        expect(extractFileName("/home/user/docs/sample.pdf")).toBe("sample.pdf");
    });

    it("ファイル名のみの文字列をそのまま返す", () => {
        expect(extractFileName("test.pdf")).toBe("test.pdf");
    });

    it("ネストされたディレクトリパスでも正しく取得できる", () => {
        expect(extractFileName("C:\\Users\\sasai\\Documents\\PyMuPDF\\tests\\test.pdf")).toBe("test.pdf");
    });
});

// ============================================================

describe("clampPage", () => {
    it("正常範囲内のページはそのまま返す", () => {
        expect(clampPage(3, 10)).toBe(3);
    });

    it("最初のページ(1)はそのまま返す", () => {
        expect(clampPage(1, 10)).toBe(1);
    });

    it("最後のページ(totalPages)はそのまま返す", () => {
        expect(clampPage(10, 10)).toBe(10);
    });

    it("0以下は1にクランプされる", () => {
        expect(clampPage(0, 10)).toBe(1);
        expect(clampPage(-5, 10)).toBe(1);
    });

    it("totalPagesを超えるとtotalPagesにクランプされる", () => {
        expect(clampPage(11, 10)).toBe(10);
        expect(clampPage(999, 10)).toBe(10);
    });
});

// ============================================================

describe("clampScale", () => {
    it("有効範囲内のスケールはそのまま返す", () => {
        expect(clampScale(1.0)).toBeCloseTo(1.0);
        expect(clampScale(2.5)).toBeCloseTo(2.5);
    });

    it("0.25未満は0.25にクランプされる", () => {
        expect(clampScale(0.1)).toBeCloseTo(0.25);
        expect(clampScale(0.0)).toBeCloseTo(0.25);
    });

    it("5.0を超えると5.0にクランプされる", () => {
        expect(clampScale(6.0)).toBeCloseTo(5.0);
        expect(clampScale(100)).toBeCloseTo(5.0);
    });

    it("境界値(0.25, 5.0)はそのまま返す", () => {
        expect(clampScale(0.25)).toBeCloseTo(0.25);
        expect(clampScale(5.0)).toBeCloseTo(5.0);
    });
});

// ============================================================

describe("scaleToPercent", () => {
    it("1.0 → '100%'", () => {
        expect(scaleToPercent(1.0)).toBe("100%");
    });

    it("0.5 → '50%'", () => {
        expect(scaleToPercent(0.5)).toBe("50%");
    });

    it("小数点以下は四捨五入される", () => {
        // 注意: JS の浮動小数点演算では 1.255 * 100 = 125.49... となるため 125% になる
        expect(scaleToPercent(1.255)).toBe("125%");
        expect(scaleToPercent(1.334)).toBe("133%");
        expect(scaleToPercent(1.5)).toBe("150%");
    });

    it("2.0 → '200%'", () => {
        expect(scaleToPercent(2.0)).toBe("200%");
    });
});

// ============================================================

describe("calcFitWidthScale", () => {
    it("コンテナ幅・ページ幅・パディングからスケールを計算できる", () => {
        // (1200 - 80) / 800 = 1.4
        expect(calcFitWidthScale(1200, 800)).toBeCloseTo(1.4);
    });

    it("カスタムパディングを指定できる", () => {
        // (1000 - 40) / 500 = 1.92
        expect(calcFitWidthScale(1000, 500, 40)).toBeCloseTo(1.92);
    });

    it("ページ幅とコンテナ幅が同じ（パディング0）なら1.0", () => {
        expect(calcFitWidthScale(500, 500, 0)).toBeCloseTo(1.0);
    });
});

// ============================================================

describe("calcNavDisabled", () => {
    const mockPdf = {}; // nullでないオブジェクトで代用

    it("pdf=nullのとき両方disabled", () => {
        const result = calcNavDisabled(null, 1, 10);
        expect(result.prevDisabled).toBe(true);
        expect(result.nextDisabled).toBe(true);
    });

    it("最初のページ(1)のとき prev は disabled", () => {
        const result = calcNavDisabled(mockPdf, 1, 10);
        expect(result.prevDisabled).toBe(true);
        expect(result.nextDisabled).toBe(false);
    });

    it("最後のページのとき next は disabled", () => {
        const result = calcNavDisabled(mockPdf, 10, 10);
        expect(result.prevDisabled).toBe(false);
        expect(result.nextDisabled).toBe(true);
    });

    it("中間ページのとき両方 enabled", () => {
        const result = calcNavDisabled(mockPdf, 5, 10);
        expect(result.prevDisabled).toBe(false);
        expect(result.nextDisabled).toBe(false);
    });

    it("1ページのみのPDF(totalPages=1)のとき両方 disabled", () => {
        const result = calcNavDisabled(mockPdf, 1, 1);
        expect(result.prevDisabled).toBe(true);
        expect(result.nextDisabled).toBe(true);
    });
});

// ============================================================
// 2. PDF.js インテグレーションテスト (tests/test.pdf を使用)
// ============================================================

describe("PDF.js インテグレーション (test.pdf)", () => {
    const TEST_PDF_PATH = resolve("tests/test.pdf");

    it("test.pdf が存在し読み込める", () => {
        const buf = readFileSync(TEST_PDF_PATH);
        expect(buf.byteLength).toBeGreaterThan(0);
    });

    it("test.pdf がPDFとして正常にロードできる", async () => {
        const buf = readFileSync(TEST_PDF_PATH);
        const uint8 = new Uint8Array(buf);
        const loadingTask = pdfjsLib.getDocument({ data: uint8 });
        const pdf = await loadingTask.promise;

        expect(pdf).toBeDefined();
        expect(pdf.numPages).toBeGreaterThan(0);
    }, 10000);

    it("test.pdf の総ページ数が取得できる", async () => {
        const buf = readFileSync(TEST_PDF_PATH);
        const uint8 = new Uint8Array(buf);
        const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;

        console.log(`  → test.pdf ページ数: ${pdf.numPages}`);
        expect(typeof pdf.numPages).toBe("number");
        expect(pdf.numPages).toBeGreaterThanOrEqual(1);
    }, 10000);

    it("1ページ目のビューポートが取得できる", async () => {
        const buf = readFileSync(TEST_PDF_PATH);
        const uint8 = new Uint8Array(buf);
        const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });

        expect(viewport.width).toBeGreaterThan(0);
        expect(viewport.height).toBeGreaterThan(0);
        console.log(`  → 1ページ目サイズ: ${viewport.width.toFixed(1)} x ${viewport.height.toFixed(1)} pt`);
    }, 10000);

    it("1ページ目のテキストコンテンツが取得できる", async () => {
        const buf = readFileSync(TEST_PDF_PATH);
        const uint8 = new Uint8Array(buf);
        const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
        const page = await pdf.getPage(1);
        const textContent = await page.getTextContent();

        expect(textContent).toBeDefined();
        expect(Array.isArray(textContent.items)).toBe(true);
        const fullText = textContent.items.map((i) => i.str).join(" ");
        console.log(`  → テキスト冒頭: "${fullText.slice(0, 80).trim()}"`);
    }, 10000);

    it("アウトライン（目次）の取得を試みる", async () => {
        const buf = readFileSync(TEST_PDF_PATH);
        const uint8 = new Uint8Array(buf);
        const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
        const outline = await pdf.getOutline();

        // outline は null か配列のどちらか
        expect(outline === null || Array.isArray(outline)).toBe(true);
        console.log(`  → アウトライン: ${outline === null ? "なし" : `${outline.length} 項目`}`);
    }, 10000);

    it("fitWidth スケール計算が test.pdf の実際のページ幅で正しく動作する", async () => {
        const buf = readFileSync(TEST_PDF_PATH);
        const uint8 = new Uint8Array(buf);
        const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });

        const containerWidth = 1200;
        const scale = calcFitWidthScale(containerWidth, viewport.width);
        const clamped = clampScale(scale);

        expect(clamped).toBeGreaterThanOrEqual(0.25);
        expect(clamped).toBeLessThanOrEqual(5.0);
        console.log(
            `  → fitWidth スケール: ${scale.toFixed(3)} → clamped: ${clamped.toFixed(3)} (${scaleToPercent(clamped)})`
        );
    }, 10000);
});
