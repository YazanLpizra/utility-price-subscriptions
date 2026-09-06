#!/usr/bin/env node
/**
 * De-wrap the Chrome "view-source" capture in docs/ into a plain HTML fixture at
 * test/fixtures/06483.html.
 *
 * The capture is NOT a plain copy of the page source: it is Chrome's
 * syntax-highlighted view-source rendering. Every original line lives in a
 * <td class="line-content">, and inside that cell the real markup is
 * HTML-ESCAPED (&lt;html&gt;) while the highlighting scaffolding
 * (<span class="html-tag">, <span class="html-attribute-name">,
 * <a class="html-attribute-value html-resource-link">, an injected
 * <base href="."> and its <!-- --> comment) is LITERAL markup.
 *
 * That asymmetry is the whole de-wrapping rule:
 *   1. take each <td class="line-content"> body,
 *   2. drop HTML comments,
 *   3. drop every remaining literal tag (all of it is scaffolding),
 *   4. unescape entities exactly once,
 *   5. join lines with "\n".
 *
 * Writes UTF-8, LF, no BOM. Idempotent. Prints the structural counts and the
 * SHA-256 of the written file. Exits non-zero if any structural assertion fails.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(
  ROOT,
  "docs",
  "view-source_https___www.cashheatingoil.com_seymour_ct_oil_prices_06483.html",
);
const OUT = join(ROOT, "test", "fixtures", "06483.html");

const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Unescape HTML entities exactly once (a single left-to-right pass). */
function unescapeOnce(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ref) => {
    if (ref[0] === "#") {
      const cp =
        ref[1] === "x" || ref[1] === "X"
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const named = NAMED[ref.toLowerCase()];
    return named === undefined ? m : named;
  });
}

function dewrap(viewSource) {
  const cellRe = /<td class="line-content"[^>]*>([\s\S]*?)<\/td>/g;
  const lines = [];
  let m;
  while ((m = cellRe.exec(viewSource)) !== null) {
    let cell = m[1];
    cell = cell.replace(/<!--[\s\S]*?-->/g, ""); // injected comments
    cell = cell.replace(/<[^>]*>/g, ""); // all remaining literal tags = scaffolding
    lines.push(unescapeOnce(cell));
  }
  if (lines.length === 0) throw new Error("no td.line-content cells found");
  return lines.join("\n");
}

// ---------------------------------------------------------------- assertions

const failures = [];

/** JSON with object keys sorted, so a plain-object comparison is order-independent. */
function stable(v) {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );
}

function check(label, actual, expected) {
  const a = stable(actual);
  const e = stable(expected);
  const ok = a === e;
  if (!ok) failures.push(`${label}: expected ${e}, got ${a}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} = ${a}${ok ? "" : ` (expected ${e})`}`);
  return ok;
}

function countMatches(html, re) {
  return (html.match(re) ?? []).length;
}

function distribution(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function assertStructure(html) {
  console.log("Structural assertions:");

  check(
    "div.boxlisting count",
    countMatches(html, /class\s*=\s*["'][^"']*\bboxlisting\b[^"']*["']/gi),
    5,
  );

  const dealerIds = [
    ...html.matchAll(
      /<input[^>]*\bname\s*=\s*["']dealerid["'][^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*>/gi,
    ),
  ].map((m) => Number(m[1]));
  check("dealerid input count", dealerIds.length, 10);
  check("dealerid values in document order", dealerIds, [
    11, 11, 372, 372, 744, 744, 345, 345, 919, 919,
  ]);

  check(
    "table.paywithcash count",
    countMatches(html, /class\s*=\s*["'][^"']*\bpaywithcash\b[^"']*["']/gi),
    5,
  );
  check(
    "table.paybycredit count",
    countMatches(html, /class\s*=\s*["'][^"']*\bpaybycredit\b[^"']*["']/gi),
    5,
  );

  const tiers = [...html.matchAll(/<td[^>]*>\s*(\d+\s*-\s*\d+)\s*<\/td>/gi)].map((m) =>
    m[1].replace(/\s+/g, ""),
  );
  check("gallon tier label count", tiers.length, 39);
  check("gallon tier distribution", distribution(tiers), {
    "50-99": 3,
    "100-149": 6,
    "150-199": 10,
    "200-299": 10,
    "300-399": 10,
  });

  const prices = [...html.matchAll(/<td[^>]*>\s*(\$\s*[\d,]+\.\d{2})\s*<\/td>/gi)].map((m) =>
    m[1].replace(/\s+/g, ""),
  );
  check("price string count", prices.length, 39);
  check("price distribution", distribution(prices), {
    "$4.84": 12,
    "$4.94": 12,
    "$5.19": 12,
    "$5.64": 1,
    "$5.74": 1,
    "$6.00": 1,
  });
}

// ---------------------------------------------------------------------- main

const viewSource = readFileSync(SRC, "utf8");
const html = dewrap(viewSource);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, { encoding: "utf8" }); // LF preserved; Node adds no BOM

const bytes = readFileSync(OUT);
if (bytes.includes("\r")) {
  failures.push("output contains CR — must be LF only");
}
if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
  failures.push("output starts with a UTF-8 BOM");
}

console.log(`Wrote ${OUT}`);
console.log(
  `  code points: ${[...html].length}   utf-16 units: ${html.length}   utf-8 bytes: ${bytes.length}`,
);
assertStructure(html);

const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`SHA-256 = ${sha256}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("All structural assertions passed.");
