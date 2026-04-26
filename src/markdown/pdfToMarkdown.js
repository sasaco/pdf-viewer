/**
 * PDF → Markdown 抽出（純JS、PDF.js 5.x ベース）。
 *
 * 入力: pdfjsLib.getDocument(...).promise が返す PDFDocumentProxy 互換オブジェクト
 *       （{ numPages: number, getPage(n): Promise<{ getTextContent, getAnnotations }> }）。
 * 出力: Markdown 文字列。空 PDF / 全アイテム空文字 のときは "" を返す（呼び出し側が判定）。
 *
 * アルゴリズム（T0 spike 結果に基づく）:
 *   1. ページごとに getTextContent() で items[] を取得し、Y 座標で行に集約。
 *   2. 各行の代表フォントサイズ（中央値, transform[3] ベース）を取得。
 *   3. ページ全体で本文サイズ（文字数で重み付けした最頻値）を決定。
 *   4. 同 Y に複数 X クラスタがある行はテーブル行として処理（最低 2 行揃ったときのみ）。
 *   5. 箇条書き先頭マーカ (•, ・, -, *, 数字+. ) は `- ` に正規化。
 *   6. リンクアノテーション (subtype:'Link') の rect と重なる行は [text](url) に変換。
 *      url は http(s) のみ許容、`)` を %29 にエンコードして Markdown 構造を保護。
 *   7. 連続する同サイズ・近接 Y 行は段落として 1 行に結合し、Y ギャップ／見出しサイズで段落区切り。
 */

const Y_LINE_TOLERANCE = 2.5;
const PARA_GAP_FACTOR = 2.5;
const TABLE_MIN_COLS = 3;
const TABLE_X_GAP_FACTOR = 3;
const TABLE_MIN_ROWS = 2; // ヘッダ＋本文の最低 2 行が揃ったときのみ table とする
const HEADING_SIZE_FACTOR = 1.25;

const BULLET_LEAD_RE = /^\s*([•・·▪◦●○■□◆◇▶►‣⁃]|-|\*)\s+/;
const NUMBERED_LEAD_RE = /^\s*\d+[.)、]\s+/;

function isPdfLike(x) {
  return (
    x &&
    typeof x === "object" &&
    typeof x.numPages === "number" &&
    typeof x.getPage === "function"
  );
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** http/https のみ許容、`new URL().href` で正規化したうえで Markdown 構造を壊す
 *  文字 (`(`, `)`) を %エンコードして保護する。
 *  javascript:, data:, file:, vbscript:, ftp: などは null を返してリンク化を抑止する。
 *  改行・制御文字を含む URL は `new URL` がパースできても safety net として弾く。 */
function sanitizeUrl(url) {
  if (typeof url !== "string" || !url) return null;
  // 制御文字 (\x00-\x1f, \x7f) と Unicode 行/段落セパレータ (U+2028/U+2029) を含む URL は安全側で拒否
  if (/[\x00-\x1f\x7f\u2028\u2029]/.test(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // URL に Basic 認証 credentials が含まれる場合、Markdown 経由で漏洩するリスクがあるため拒否。
  if (parsed.username || parsed.password) return null;
  // parsed.href は WHATWG URL パーサーが正規化済み（空白→%20、" → %22 等）。
  // 残るは Markdown 構文の `(` `)` を破壊しないようさらにエンコード。
  return parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** items[] を Y で行にグルーピング */
function groupItemsByLine(items) {
  const valid = items.filter(
    (it) => it && Array.isArray(it.transform) && typeof it.str === "string"
  );
  valid.sort((a, b) => b.transform[5] - a.transform[5]);

  const lines = [];
  let current = null;
  for (const it of valid) {
    const y = it.transform[5];
    if (current && Math.abs(current.y - y) <= Y_LINE_TOLERANCE) {
      current.items.push(it);
    } else {
      current = { y, items: [it] };
      lines.push(current);
    }
  }

  for (const ln of lines) {
    ln.items.sort((a, b) => a.transform[4] - b.transform[4]);
    ln.size = median(
      ln.items
        .map((it) => it.transform[3])
        .filter((s) => Number.isFinite(s) && s > 0)
    );
  }
  return lines;
}

/** item の実効幅。width=0 の CJK 等にフォールバックする際は size を使う（半角推定 0.5 ではなく ~1.0）。 */
function effectiveItemWidth(it) {
  if (it.width && it.width > 0) return it.width;
  const size = it.transform[3] || 12;
  const s = it.str || "";
  if (!s) return 0;
  // CJK 文字は 1 文字 ~= size（全角）。半角は ~= size * 0.5。混在は平均 0.7 で近似。
  // 範囲: U+3000-U+9FFF（CJK 統合漢字 + ひらがな/カタカナ等）、U+FF00-U+FFEF（半角全角形式）、
  //       U+20000-U+2FA1F（CJK 統合漢字拡張 B-F）。後者はサロゲートペアなので codePoint で判定。
  // codePoint 単位で数える（サロゲートペアを 1 文字として扱う）。s.length は UTF-16 単位なので使わない。
  let cjk = 0;
  let total = 0;
  for (const ch of s) {
    total++;
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x3000 && cp <= 0x9fff) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0x20000 && cp <= 0x2fa1f)
    ) {
      cjk++;
    }
  }
  if (total === 0) return 0;
  const ratio = cjk / total;
  const factor = ratio > 0.5 ? 1.0 : ratio > 0 ? 0.7 : 0.5;
  return total * size * factor;
}

function lineToText(items) {
  let out = "";
  let prevEndX = null;
  let prevSize = null;
  for (const it of items) {
    const str = it.str || "";
    if (!str) continue;
    const x = it.transform[4];
    const size = it.transform[3] || prevSize || 12;
    if (prevEndX !== null) {
      const gap = x - prevEndX;
      if (gap > size * 0.3 && !out.endsWith(" ") && !str.startsWith(" ")) {
        out += " ";
      }
    }
    out += str;
    prevEndX = x + effectiveItemWidth(it);
    prevSize = size;
  }
  return out.replace(/\s+$/g, "");
}

function detectColumns(items, bodySize) {
  if (items.length < TABLE_MIN_COLS) return null;
  const clusters = [];
  let cur = [items[0]];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const it = items[i];
    const prevEndX = prev.transform[4] + effectiveItemWidth(prev);
    const gap = it.transform[4] - prevEndX;
    const threshold = (bodySize || it.transform[3] || 12) * TABLE_X_GAP_FACTOR;
    if (gap > threshold) {
      clusters.push(cur);
      cur = [it];
    } else {
      cur.push(it);
    }
  }
  clusters.push(cur);
  if (clusters.length < TABLE_MIN_COLS) return null;
  return clusters.map((c) => lineToText(c).trim());
}

function findLinkForLine(line, links) {
  if (!links || links.length === 0) return null;
  const lineY = line.y;
  const xs = line.items.map((it) => it.transform[4]);
  const xe = line.items.map((it) => it.transform[4] + effectiveItemWidth(it));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xe);
  for (const a of links) {
    if (!a.rect || a.rect.length < 4) continue;
    const [x1, y1, x2, y2] = a.rect;
    const ymin = Math.min(y1, y2);
    const ymax = Math.max(y1, y2);
    const axmin = Math.min(x1, x2);
    const axmax = Math.max(x1, x2);
    if (lineY >= ymin - 1 && lineY <= ymax + line.size + 1) {
      if (xMax >= axmin && xMin <= axmax) {
        const safe = sanitizeUrl(a.url);
        if (safe) return safe;
      }
    }
  }
  return null;
}

function normalizeBullet(text) {
  const m1 = text.match(BULLET_LEAD_RE);
  if (m1) return "- " + text.slice(m1[0].length);
  const m2 = text.match(NUMBERED_LEAD_RE);
  if (m2) return "- " + text.slice(m2[0].length);
  return null;
}

function isHeadingSize(size, headingSizes) {
  return headingSizes.some((s) => size >= s - 0.05);
}

function renderPageBlocks(lines, links, bodySize, headingSizes) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const text = lineToText(ln.items).trim();
    if (!text) {
      i++;
      continue;
    }

    // テーブル: 先頭行を含めて連続する同列数行を集める
    const cols = detectColumns(ln.items, bodySize);
    if (cols) {
      const tableRows = [cols];
      let prevY = ln.y;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        const yGap = prevY - next.y;
        if (yGap > (bodySize || next.size) * 3) break;
        const ncols = detectColumns(next.items, bodySize);
        if (!ncols || ncols.length !== cols.length) break;
        tableRows.push(ncols);
        prevY = next.y;
        j++;
      }
      if (tableRows.length >= TABLE_MIN_ROWS) {
        const header = tableRows[0];
        const sep = header.map(() => "---");
        const body = tableRows.slice(1);
        const lns = [
          "| " + header.join(" | ") + " |",
          "| " + sep.join(" | ") + " |",
          ...body.map((r) => "| " + r.join(" | ") + " |"),
        ];
        blocks.push({ kind: "table", text: lns.join("\n") });
        i = j;
        continue;
      }
      // テーブル不成立ならフォールスルーして通常段落として処理
    }

    const headingLevel = (() => {
      if (!headingSizes.length) return 0;
      const idx = headingSizes.findIndex((s) => ln.size >= s - 0.05);
      return idx < 0 ? 0 : Math.min(idx + 1, 4);
    })();

    const bullet = normalizeBullet(text);
    const url = findLinkForLine(ln, links);
    let outText = bullet || text;
    if (url) {
      if (bullet) {
        outText =
          "- " +
          `[${text.replace(BULLET_LEAD_RE, "").replace(NUMBERED_LEAD_RE, "")}](${url})`;
      } else {
        outText = `[${text}](${url})`;
      }
    }

    if (headingLevel > 0 && !bullet) {
      blocks.push({ kind: "heading", level: headingLevel, text: outText });
      i++;
      continue;
    }

    if (bullet) {
      const items = [outText];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        const ntext = lineToText(nxt.items).trim();
        if (!ntext) break;
        const nb = normalizeBullet(ntext);
        if (!nb) break;
        const nurl = findLinkForLine(nxt, links);
        items.push(
          nurl
            ? "- " +
                `[${ntext
                  .replace(BULLET_LEAD_RE, "")
                  .replace(NUMBERED_LEAD_RE, "")}](${nurl})`
            : nb
        );
        j++;
      }
      blocks.push({ kind: "list", text: items.join("\n") });
      i = j;
      continue;
    }

    // 段落
    const paraLines = [outText];
    let prevY = ln.y;
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j];
      const ntext = lineToText(nxt.items).trim();
      if (!ntext) break;
      if (Math.abs(nxt.size - ln.size) > 0.5) break;
      if (isHeadingSize(nxt.size, headingSizes)) break; // 次が見出しサイズなら段落終端
      const yGap = prevY - nxt.y;
      const lineHeight = ln.size || bodySize || 12;
      if (yGap > lineHeight * PARA_GAP_FACTOR) break;
      if (normalizeBullet(ntext)) break;
      if (detectColumns(nxt.items, bodySize)) break;
      const nurl = findLinkForLine(nxt, links);
      paraLines.push(nurl ? `[${ntext}](${nurl})` : ntext);
      prevY = nxt.y;
      j++;
    }
    blocks.push({ kind: "paragraph", text: paraLines.join(" ") });
    i = j;
  }
  return blocks;
}

function renderMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind === "heading") {
      out.push("#".repeat(b.level) + " " + b.text);
    } else {
      out.push(b.text);
    }
  }
  return out.join("\n\n");
}

/**
 * メインエントリ。
 * @param {object} pdf - PDFDocumentProxy 互換
 * @param {{ maxPages?: number, signal?: AbortSignal, onPageError?: (err, pageNum) => void }} [options]
 * @returns {Promise<string>}
 */
export async function pdfToMarkdown(pdf, options = {}) {
  if (!isPdfLike(pdf)) {
    throw new Error("pdfToMarkdown: input is not a PDF document");
  }
  if (pdf.numPages <= 0) {
    return ""; // 0 ページは空文字。caller 側で「抽出できませんでした」と判定する想定。
  }
  const maxPages = Math.min(options.maxPages ?? pdf.numPages, pdf.numPages);
  const signal = options.signal;
  const onPageError =
    options.onPageError ||
    ((err, pageNum) =>
      console.warn(`pdfToMarkdown: page ${pageNum} extraction failed:`, err?.message ?? err));

  const perPage = [];
  for (let p = 1; p <= maxPages; p++) {
    if (signal?.aborted) {
      const e = new Error("pdfToMarkdown: aborted");
      e.name = "AbortError";
      throw e;
    }
    let page;
    let lines = [];
    let links = [];
    try {
      page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      lines = groupItemsByLine(tc.items || []);
    } catch (err) {
      onPageError(err, p);
      perPage.push({ lines: [], links: [] });
      continue;
    }
    // annotations 失敗はテキスト抽出を捨てない（リンクのみ落とす）
    try {
      const annsAll = (await page.getAnnotations()) || [];
      links = annsAll.filter((a) => a && a.subtype === "Link" && a.url);
    } catch (err) {
      onPageError(err, p);
    }
    perPage.push({ lines, links });
  }

  const charWeighted = new Map();
  for (const pg of perPage) {
    for (const l of pg.lines) {
      if (!(l.size > 0)) continue;
      const len = l.items.reduce((s, it) => s + (it.str?.length || 0), 0);
      const k = Math.round(l.size * 10) / 10;
      charWeighted.set(k, (charWeighted.get(k) || 0) + len);
    }
  }
  let bodySize = 12;
  let bodyWeight = 0;
  for (const [k, w] of charWeighted) {
    if (w > bodyWeight) {
      bodyWeight = w;
      bodySize = k;
    }
  }
  const uniqueSizes = [...charWeighted.keys()]
    .filter((s) => s >= bodySize * HEADING_SIZE_FACTOR)
    .sort((a, b) => b - a);

  const blocks = [];
  for (const pg of perPage) {
    blocks.push(...renderPageBlocks(pg.lines, pg.links, bodySize, uniqueSizes));
  }
  return renderMarkdown(blocks);
}

export default pdfToMarkdown;
