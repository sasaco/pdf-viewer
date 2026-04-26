// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  convertToMarkdown,
  convertPdfDocumentToMarkdown,
} from "../../src/markdown/convert.js";

describe("convertToMarkdown — phase 1 dispatcher", () => {
  it("rejects non-pdf extensions in phase 1", async () => {
    for (const name of ["x.docx", "x.html", "x.pptx", "x.xlsx", "x.txt", "noext"]) {
      await expect(
        convertToMarkdown({ name, arrayBuffer: new ArrayBuffer(0) })
      ).rejects.toThrow(/format not supported in phase 1/);
    }
  });

  it("rejects when name is missing", async () => {
    await expect(
      convertToMarkdown({ arrayBuffer: new ArrayBuffer(0) })
    ).rejects.toThrow(/format not supported in phase 1/);
    await expect(convertToMarkdown({})).rejects.toThrow(
      /format not supported in phase 1/
    );
  });

  it("rejects when arrayBuffer is missing for .pdf", async () => {
    await expect(convertToMarkdown({ name: "x.pdf" })).rejects.toThrow(
      /no data \(arrayBuffer is required\)/
    );
  });

  it("dispatches .pdf to pdfToMarkdown via injected loader", async () => {
    const fakePdf = { numPages: 0, async getPage() {}, async destroy() {} };
    const loader = vi.fn().mockResolvedValue(fakePdf);
    const md = await convertToMarkdown(
      { name: "doc.pdf", arrayBuffer: new ArrayBuffer(8) },
      {
        _loadPdf: loader,
        _pdfToMarkdown: async (pdf) => {
          expect(pdf).toBe(fakePdf);
          return "# fake";
        },
      }
    );
    expect(md).toBe("# fake");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("forwards signal / maxPages / onPageError to renderer", async () => {
    const ac = new AbortController();
    const onPageError = () => {};
    const seen = {};
    const fakePdf = { numPages: 0, async getPage() {}, async destroy() {} };
    await convertToMarkdown(
      { name: "doc.pdf", arrayBuffer: new ArrayBuffer(8) },
      {
        signal: ac.signal,
        maxPages: 3,
        onPageError,
        _loadPdf: async () => fakePdf,
        _pdfToMarkdown: async (_pdf, opts) => {
          Object.assign(seen, opts);
          return "";
        },
      }
    );
    expect(seen.signal).toBe(ac.signal);
    expect(seen.maxPages).toBe(3);
    expect(seen.onPageError).toBe(onPageError);
  });

  it("calls pdf.destroy after rendering even if rendering throws", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const fakePdf = { numPages: 0, async getPage() {}, destroy };
    await expect(
      convertToMarkdown(
        { name: "x.pdf", arrayBuffer: new ArrayBuffer(8) },
        {
          _loadPdf: async () => fakePdf,
          _pdfToMarkdown: async () => {
            throw new Error("render fail");
          },
        }
      )
    ).rejects.toThrow(/render fail/);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("does not crash when pdf.destroy itself rejects (warning is logged)", async () => {
    const destroy = vi.fn().mockRejectedValue(new Error("destroy fail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fakePdf = { numPages: 0, async getPage() {}, destroy };
      const md = await convertToMarkdown(
        { name: "x.pdf", arrayBuffer: new ArrayBuffer(8) },
        {
          _loadPdf: async () => fakePdf,
          _pdfToMarkdown: async () => "# ok",
        }
      );
      expect(md).toBe("# ok");
      expect(destroy).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("convertPdfDocumentToMarkdown — UI-side helper", () => {
  it("delegates to pdfToMarkdown without destroying the document", async () => {
    const fakePdf = {
      numPages: 1,
      async getPage() {},
      destroy: vi.fn(),
    };
    const md = await convertPdfDocumentToMarkdown(fakePdf, {
      _pdfToMarkdown: async (pdf) => {
        expect(pdf).toBe(fakePdf);
        return "# delegated";
      },
    });
    expect(md).toBe("# delegated");
    expect(fakePdf.destroy).not.toHaveBeenCalled();
  });

  it("propagates signal / maxPages / onPageError via deps", async () => {
    const seen = {};
    const ac = new AbortController();
    const onPageError = () => {};
    await convertPdfDocumentToMarkdown(
      { numPages: 0, async getPage() {} },
      {
        signal: ac.signal,
        maxPages: 7,
        onPageError,
        _pdfToMarkdown: async (_pdf, opts) => {
          Object.assign(seen, opts);
          return "";
        },
      }
    );
    expect(seen.signal).toBe(ac.signal);
    expect(seen.maxPages).toBe(7);
    expect(seen.onPageError).toBe(onPageError);
  });
});
