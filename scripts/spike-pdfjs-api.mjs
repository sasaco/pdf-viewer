// T0 spike: pdfjs-dist 5.5.x の getTextContent / getAnnotations 確認
// 実行: node scripts/spike-pdfjs-api.mjs tests/test3.pdf
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url
).href;

const target = process.argv[2] || "tests/test3.pdf";
const data = new Uint8Array(await readFile(target));
const pdf = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;

console.log(`# ${target}: numPages=${pdf.numPages}`);

const sample = Math.min(pdf.numPages, 3);
for (let p = 1; p <= sample; p++) {
  const page = await pdf.getPage(p);
  const tc = await page.getTextContent();
  const anns = await page.getAnnotations();
  console.log(`\n--- page ${p}: textItems=${tc.items.length}, annotations=${anns.length} ---`);
  for (const it of tc.items.slice(0, 5)) {
    const t = it.transform || [];
    console.log({
      str: (it.str || "").slice(0, 30),
      transform: t,
      "transform[0]": t[0],
      "transform[3]": t[3],
      "transform[5]": t[5],
      height: it.height,
      width: it.width,
      fontName: it.fontName,
      hasEOL: it.hasEOL,
    });
  }
  for (const a of anns.slice(0, 5)) {
    console.log({ subtype: a.subtype, url: a.url, dest: a.dest, rect: a.rect });
  }
}

await pdf.destroy();
