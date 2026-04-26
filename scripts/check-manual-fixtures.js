#!/usr/bin/env node
/**
 * scripts/check-manual-fixtures.js
 *
 * 手動テスト計画 (docs/plan/manual-test-plan-2026-04-26.md) §3-0 ゲートで使用。
 * tests/fixtures/manual/ 配下に必須の PDF が揃っているか検査する。
 * 欠落があれば exit 1 で不在ファイルを列挙。依存ゼロ (Node.js 標準のみ)。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "tests", "fixtures", "manual");

const required = [
  "with_toc.pdf",
  "multipage_50p.pdf",
  "scanned_image_only.pdf",
  "with_links.pdf",
  "with_links_evil.pdf",
  "unicode.pdf",
  "partial_broken.pdf",
  "error/corrupted.pdf",
  "error/empty.pdf",
  "error/fake.pdf",
  "error/password.pdf",
];

const missing = required.filter((f) => !existsSync(join(root, f)));

if (missing.length) {
  console.error("MISSING manual fixtures (" + missing.length + " file(s)):");
  for (const f of missing) {
    console.error("  - tests/fixtures/manual/" + f);
  }
  console.error("\n手順は docs/plan/manual-test-plan-2026-04-26.md §2-A を参照。");
  process.exit(1);
}

console.log("OK: all " + required.length + " manual fixtures present");
