// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { pdfToMarkdown } from "../../src/markdown/pdfToMarkdown.js";

let pdfjs;
beforeAll(async () => {
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Windows では `file://C:/...` ではなく `file:///C:/...` が正解。pathToFileURL に委譲。
  const workerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
  );
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadPdf(relPath) {
  const data = new Uint8Array(await readFile(path.join(__dirname, "..", relPath)));
  return await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
}

function fixturePath(relPath) {
  return path.join(__dirname, "..", relPath);
}
function fixtureExists(relPath) {
  return existsSync(fixturePath(relPath));
}

function mockPdf(pages) {
  return {
    numPages: pages.length,
    async getPage(n) {
      return {
        async getTextContent() {
          return { items: pages[n - 1].items };
        },
        async getAnnotations() {
          return pages[n - 1].annotations || [];
        },
      };
    },
    async destroy() {},
  };
}

function mkItem(str, x, y, size, fontName = "f1", hasEOL = false) {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: str.length * size * 0.5,
    height: str === "" ? 0 : size,
    fontName,
    hasEOL,
  };
}

describe("pdfToMarkdown — unit (mocked PDF)", () => {
  it("extracts H1 from largest font size line", async () => {
    const pdf = mockPdf([
      {
        items: [
          mkItem("Title Heading", 50, 800, 24, "f-bold"),
          mkItem("body line one", 50, 760, 12, "f-body"),
          mkItem("body line two", 50, 745, 12, "f-body"),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    expect(md).toMatch(/^# Title Heading/m);
  });

  it("joins consecutive same-font lines into a paragraph (no blank line within)", async () => {
    const pdf = mockPdf([
      {
        items: [
          mkItem("first line of para one.", 50, 700, 12, "f-body"),
          mkItem("second line of para one.", 50, 685, 12, "f-body"),
          mkItem("first line of para two.", 50, 600, 12, "f-body"),
          mkItem("second line of para two.", 50, 585, 12, "f-body"),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    // 段落内は空行なしで結合されること（同段落内に \n\n が現れない）
    expect(md).not.toMatch(/first line of para one\.[^\n]*\n\n[^\n]*second line of para one\./);
    // 段落 1 と 2 の間には空行（\n\n）が入ること
    expect(md).toMatch(/para one\.[\s\S]*\n\n[\s\S]*para two/);
  });

  it("breaks paragraph when next line is heading-sized", async () => {
    const pdf = mockPdf([
      {
        items: [
          mkItem("body line A", 50, 700, 10),
          mkItem("body line B", 50, 685, 10),
          mkItem("Section Header", 50, 660, 16),
          mkItem("body line C", 50, 640, 10),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    // body line と heading が同段落に混入しないこと
    expect(md).not.toMatch(/body line B Section Header/);
    expect(md).toMatch(/^#+ Section Header/m);
  });

  it("detects bullet list (•, -, *)", async () => {
    const pdf = mockPdf([
      {
        items: [
          mkItem("• apple", 50, 700, 12),
          mkItem("• banana", 50, 685, 12),
          mkItem("- cherry", 50, 670, 12),
          mkItem("* date", 50, 655, 12),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    expect(md).toMatch(/^- apple$/m);
    expect(md).toMatch(/^- banana$/m);
    expect(md).toMatch(/^- cherry$/m);
    expect(md).toMatch(/^- date$/m);
  });

  it("detects numbered list as `- item` (phase 1 simplified)", async () => {
    const pdf = mockPdf([
      {
        items: [
          mkItem("1. first", 50, 700, 12),
          mkItem("2. second", 50, 685, 12),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    expect(md).toMatch(/^- first$/m);
    expect(md).toMatch(/^- second$/m);
  });

  it("reflects link annotation as [text](url)", async () => {
    const pdf = mockPdf([
      {
        items: [mkItem("Visit Anthropic site", 50, 700, 12)],
        annotations: [
          {
            subtype: "Link",
            url: "https://www.anthropic.com",
            rect: [45, 695, 250, 715],
          },
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    // new URL().href により末尾 `/` が補完される（仕様）
    expect(md).toMatch(/\[Visit Anthropic site\]\(https:\/\/www\.anthropic\.com\/?\)/);
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["vbscript:msgbox(1)"],
    ["ftp://example.com/file"],
    // 制御文字（改行）混入: WHATWG URL パーサがパースできても弾く
    ["https://example.com/\njavascript:alert(1)"],
    ["https://example.com/\x00bad"],
    // Unicode 行/段落セパレータ
    ["https://example.com/\u2028break"],
    ["https://example.com/\u2029break"],
    // Basic 認証 credentials → Markdown 経由の漏洩防止
    ["https://user:pass@example.com/path"],
    ["https://:secret@example.com/"],
  ])("rejects unsafe URL scheme/control-char: %s", async (badUrl) => {
    const pdf = mockPdf([
      {
        items: [mkItem("Click here", 50, 700, 12)],
        annotations: [
          { subtype: "Link", url: badUrl, rect: [45, 695, 250, 715] },
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    // テキストはそのまま、リンク構文は混入しないこと
    expect(md).toContain("Click here");
    expect(md).not.toMatch(/\]\(/);
  });

  it("escapes '(' and ')' in URL to %28/%29 to preserve markdown structure", async () => {
    const pdf = mockPdf([
      {
        items: [mkItem("PDF link", 50, 700, 12)],
        annotations: [
          {
            subtype: "Link",
            url: "https://example.com/file(1).pdf",
            rect: [45, 695, 250, 715],
          },
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    // ) は %29、( は %28 に正規化されていること（new URL().href ベース）
    expect(md).toMatch(/\[PDF link\]\(https:\/\/example\.com\/file%28[^()\s]*%29\.pdf\)/);
    // 生の `(` `)` がリンクの URL 部に残らないこと
    expect(md).not.toMatch(/\(https:\/\/example\.com\/file\(/);
  });

  it("normalizes URL with whitespace and quotes via new URL().href", async () => {
    const pdf = mockPdf([
      {
        items: [mkItem("Link", 50, 700, 12)],
        annotations: [
          {
            subtype: "Link",
            url: 'https://example.com/path with "quotes"',
            rect: [45, 695, 250, 715],
          },
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    // 空白は %20、" は %22 に正規化されること
    expect(md).toMatch(/\]\(https:\/\/example\.com\/path%20with%20%22quotes%22\)/);
  });

  it("emits table when same-Y multi-X clusters exist over >= 2 rows", async () => {
    // X 間隔は bodySize(12) * TABLE_X_GAP_FACTOR(3) = 36 を超える必要がある。
    // 列幅を bodySize の 12 倍で取り意図的に明示。
    const pdf = mockPdf([
      {
        items: [
          mkItem("Name", 50, 700, 12),
          mkItem("Age", 200, 700, 12),
          mkItem("City", 350, 700, 12),
          mkItem("Alice", 50, 685, 12),
          mkItem("30", 200, 685, 12),
          mkItem("Tokyo", 350, 685, 12),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    expect(md).toMatch(/\|.*Name.*\|.*Age.*\|.*City.*\|/);
    expect(md).toMatch(/\|.*Alice.*\|.*30.*\|.*Tokyo.*\|/);
  });

  it("does NOT emit a table for a single header row (no body rows)", async () => {
    const pdf = mockPdf([
      {
        items: [
          mkItem("Name", 50, 700, 12),
          mkItem("Age", 200, 700, 12),
          mkItem("City", 350, 700, 12),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    expect(md).not.toMatch(/^\|/m);
    // 段落としては存在し、テキストは保持されること
    expect(md).toContain("Name");
    expect(md).toContain("Age");
    expect(md).toContain("City");
  });

  it("rejects non-PDF-like input with descriptive error", async () => {
    await expect(pdfToMarkdown(null)).rejects.toThrow(/not a PDF document/);
    await expect(pdfToMarkdown(undefined)).rejects.toThrow(/not a PDF document/);
    await expect(pdfToMarkdown({})).rejects.toThrow(/not a PDF document/);
    await expect(pdfToMarkdown(42)).rejects.toThrow(/not a PDF document/);
    await expect(pdfToMarkdown("pdf")).rejects.toThrow(/not a PDF document/);
  });

  it("returns empty string for 0-page PDF", async () => {
    const pdf = mockPdf([]);
    const md = await pdfToMarkdown(pdf);
    expect(md).toBe("");
  });

  it("returns empty string when all items are empty strings", async () => {
    const pdf = mockPdf([
      {
        items: [
          mkItem("", 50, 700, 12),
          mkItem(" ", 50, 685, 12),
        ],
      },
    ]);
    const md = await pdfToMarkdown(pdf);
    expect(md.trim()).toBe("");
  });

  it("continues extraction when a single page throws (records via onPageError)", async () => {
    const errs = [];
    const pdf = {
      numPages: 3,
      async getPage(n) {
        if (n === 2) throw new Error("boom on page 2");
        return {
          async getTextContent() {
            return { items: [mkItem(`page ${n} body`, 50, 700, 12)] };
          },
          async getAnnotations() {
            return [];
          },
        };
      },
      async destroy() {},
    };
    const md = await pdfToMarkdown(pdf, {
      onPageError: (e, p) => errs.push([p, e.message]),
    });
    expect(md).toContain("page 1 body");
    expect(md).toContain("page 3 body");
    expect(errs).toEqual([[2, "boom on page 2"]]);
  });

  it("aborts when AbortSignal is signaled before start", async () => {
    const ac = new AbortController();
    ac.abort();
    const pdf = mockPdf([{ items: [mkItem("text", 50, 700, 12)] }]);
    await expect(pdfToMarkdown(pdf, { signal: ac.signal })).rejects.toThrow(
      /aborted/
    );
  });

  it("aborts mid-extraction (between pages) and discards partial results", async () => {
    const ac = new AbortController();
    let pagesProcessed = 0;
    const pdf = {
      numPages: 5,
      async getPage(n) {
        pagesProcessed = n;
        // 2 ページ目処理後に abort を立てる
        if (n === 2) ac.abort();
        return {
          async getTextContent() {
            return { items: [mkItem(`page ${n}`, 50, 700, 12)] };
          },
          async getAnnotations() {
            return [];
          },
        };
      },
      async destroy() {},
    };
    await expect(pdfToMarkdown(pdf, { signal: ac.signal })).rejects.toThrow(
      /aborted/
    );
    // abort は getPage(2) 終了直後にチェックされる → 3 ページ目以降は処理されない
    expect(pagesProcessed).toBeLessThanOrEqual(2);
  });

  it("annotations failure does not discard text content for that page", async () => {
    const errs = [];
    const pdf = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [mkItem("body kept", 50, 700, 12)] };
          },
          async getAnnotations() {
            throw new Error("annotations boom");
          },
        };
      },
      async destroy() {},
    };
    const md = await pdfToMarkdown(pdf, {
      onPageError: (e, p) => errs.push([p, e.message]),
    });
    expect(md).toContain("body kept");
    expect(errs).toEqual([[1, "annotations boom"]]);
  });
});

describe("pdfToMarkdown — integration with real PDFs (structural assertions)", () => {
  it.skipIf(!fixtureExists("test3.pdf"))("test3.pdf: emits H1, multiple paragraphs, and contains known content keywords", async () => {
    let pdf;
    try {
      pdf = await loadPdf("test3.pdf");
      const md = await pdfToMarkdown(pdf);
      expect(md.length).toBeGreaterThan(100);
      expect(md).toMatch(/^# /m);
      const blocks = md.split(/\n\n+/).filter((b) => b.trim().length > 0);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      // T0 spike で確認した test3.pdf の本文に確実に含まれるキーワード
      // （Obsidian + Claude Code 関連の技術記事）
      expect(md).toContain("Obsidian");
      expect(md).toContain("Claude Code");
    } finally {
      if (pdf) await pdf.destroy();
    }
  });

  // ユーザー提供のゴールデン参照 (`tests/api_request_if_v4r7.{pdf,md}`)。
  // 人間レビュー済み MD は手動整形（テーブル化、コードブロック、見出し付与等）を含むため、
  // 実装出力との完全一致は要求しない。スモーク + 共通キーワードのみ検証する。
  const goldenAvailable =
    fixtureExists("api_request_if_v4r7.pdf") &&
    fixtureExists("api_request_if_v4r7.md");
  it.skipIf(!goldenAvailable)("api_request_if_v4r7.pdf: extraction is non-trivial and shares keywords with golden MD", async () => {
    let pdf;
    try {
      pdf = await loadPdf("api_request_if_v4r7.pdf");
      const md = await pdfToMarkdown(pdf);
      const golden = await readFile(
        fixturePath("api_request_if_v4r7.md"),
        "utf8"
      );
      // 抽出が空でないこと、ゴールデンも非空であること
      expect(md.length).toBeGreaterThan(500);
      expect(golden.length).toBeGreaterThan(500);
      // ゴールデン MD に出てくる主要キーワードが実装出力にも含まれていること
      // （PDF 由来のテキストが正しく取れていることのスモーク）
      const goldenKeywords = ["立花証券", "REQUEST", "業務", "応答", "Copyright"];
      for (const kw of goldenKeywords) {
        // golden 自体にキーワードが含まれていることを先に保証 → md にも含まれていることを assert
        expect(golden).toContain(kw);
        expect(md).toContain(kw);
      }
    } finally {
      if (pdf) await pdf.destroy();
    }
  }, 30_000);

  // test2.pdf は 282MB / 3382 ページの大規模 PDF。最初の 2 ページのみ抽出して
  // 「大規模 PDF でも maxPages で制限すれば動作する」スモークのみを検証する。
  it.skipIf(!fixtureExists("test2.pdf"))("test2.pdf: first 2 pages produce non-empty markdown without crashing", async () => {
    let pdf;
    try {
      pdf = await loadPdf("test2.pdf");
      const md = await pdfToMarkdown(pdf, { maxPages: 2 });
      expect(md.length).toBeGreaterThan(0);
      expect(md).toMatch(/^#+ /m);
    } finally {
      if (pdf) await pdf.destroy();
    }
  }, 60_000);
});
