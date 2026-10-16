/**
 * Phase 2 — HTML parser.
 *
 * Turns one cashheatingoil.com results page into `ParsedListing[]` using
 * `HTMLRewriter` only. No DOM library, no cheerio, no regex pass over the whole
 * document — regexes here are applied *only* to text that HTMLRewriter has
 * already isolated into a single label or table cell.
 *
 * The parser is an explicit state machine (implementation-plan §5 Phase 2,
 * §1.2 and §1.4):
 *
 *   div.boxlisting            -> opens / closes a listing draft
 *     form[action="tranction.php"]  -> opens / closes a per-form draft
 *       input[name=...]             -> hidden field values
 *       table.paywithcash|paybycredit -> declares the form's payment table class
 *         td                        -> tier cells, paired two at a time
 *     label.formtxt / label.varlabel -> caption -> value metadata pairs
 *
 * Text finalisation rule (§1.4, and this is load-bearing): `text.lastInTextNode`
 * marks the end of ONE lexical text node, not the end of the enclosing element.
 * An element interrupted by a child (`<td>4.84 <b>x</b></td>`) or by an entity
 * boundary yields several text nodes, each with `lastInTextNode: true`. So text
 * handlers here only ever *accumulate* chunks; the complete value of a label or
 * a cell is committed in that element's `onEndTag()` handler, where the element
 * is provably finished.
 */

import type { ParsedListing, PaymentType, PriceRow, PriceTier } from "./types";

/** Hard ceiling on input size. A real results page is ~33 KB. */
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

export class ParseError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Normalise a raw text run into something matchable.
 *
 * HTMLRewriter does NOT decode HTML entities in text chunks — a `&nbsp;` in
 * the source arrives here as the six literal characters `&`,`n`,`b`,`s`,`p`,`;`,
 * not as U+00A0. (implementation-plan §1.4 claims otherwise; it is wrong, and
 * every metadata caption silently failed to match until this was fixed.) So we
 * decode the handful of entities this page actually uses, then fold U+00A0 and
 * runs of whitespace down to single spaces.
 */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(input: string): string {
  return input.replace(
    /&(?:nbsp|amp|lt|gt|quot|apos|#39);/g,
    (m) => ENTITIES[m] ?? m,
  );
}

function norm(input: string): string {
  // Called once per table cell and label — ~130 times per page — so the number
  // of passes here is worth counting.
  //
  // `decodeEntities` is skipped unless an "&" is actually present, which is
  // true of only a handful of cells. A separate NBSP fold is then redundant:
  // JavaScript's `\s` already matches U+00A0, so one collapse-and-trim does
  // what three chained passes used to.
  const decoded = input.indexOf("&") === -1 ? input : decodeEntities(input);
  return decoded.replace(/\s+/g, " ").trim();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HUMAN_DATE = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/i;
// Tier cells are matched leniently — a dealer's hand-edited table may use an en
// dash, a "gal"/"gallons" suffix, a price without "$", or a third decimal. A
// cell that still does not match is skipped, not fatal (see tiersFromForm).
const GAL_SUFFIX = String.raw`(?:\s*gal(?:lon)?s?\.?)?`;
const GALLONS_RANGE = new RegExp(String.raw`^(\d+)\s*[-–—]\s*(\d+)\s*\+?${GAL_SUFFIX}$`, "i");
const GALLONS_OPEN = new RegExp(String.raw`^(\d+)\s*\+${GAL_SUFFIX}$`, "i");
const PRICE_CELL = /^\$?\s*(\d[\d,]*\.\d{2,3})\s*(?:\/\s*gal(?:lon)?\.?)?$/i;
const MONEY = /^\$\s*([\d,]+(?:\.\d{1,2})?)$/;

/** "Sep 5th 2026" -> "2026-09-05"; returns null when unparseable. */
export function parseHumanDate(input: string): string | null {
  const m = HUMAN_DATE.exec(norm(input));
  if (!m) return null;
  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const year = Number(m[3]);
  if (!Number.isInteger(year)) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

// ---------------------------------------------------------------------------
// Internal draft state
// ---------------------------------------------------------------------------

interface FormDraft {
  dealerIds: string[];
  enumTypes: string[];
  earliestDates: string[];
  /** from `table.paywithcash` / `table.paybycredit`; null when no price table. */
  tableClass: PaymentType | null;
  /** finalised `td` texts of the price table, in document order. */
  cells: string[];
}

interface ListingDraft {
  index: number;
  forms: FormDraft[];
  meta: Map<string, string>;
}

function newForm(): FormDraft {
  return {
    dealerIds: [],
    enumTypes: [],
    earliestDates: [],
    tableClass: null,
    cells: [],
  };
}

function normaliseEnumType(raw: string): PaymentType | null {
  const v = norm(raw).toLowerCase();
  if (v === "cash") return "cash";
  if (v === "credit") return "credit";
  return null;
}

/** "Delivery Date&nbsp;:&nbsp;" -> "delivery date" */
function captionKey(raw: string): string {
  return norm(raw).replace(/:$/, "").trim().toLowerCase();
}

/**
 * Records a piece of the page that was ignored rather than parsed. Skips are
 * deliberately NOT errors: one unreadable listing must not cost the day's data
 * for every other dealer on the page. They stay visible in Workers Logs.
 */
function skip(message: string): void {
  console.warn(`PARSE_SKIP ${message}`);
}

/** A real listing is ~6 KB; the cap only guards the log line against a runaway slice. */
const MAX_LOGGED_LISTING_CHARS = 16 * 1024;

/**
 * Logs a listing that could not be parsed, with enough of it to reproduce the
 * failure offline: the listing's raw HTML plus what the parser extracted from
 * it. Grep Workers Logs for PARSE_SKIP_LISTING, save `html` as a fixture, and
 * tune the parser against it. One JSON line so the logs viewer indexes fields.
 */
function logSkippedListing(
  html: string,
  draft: ListingDraft,
  err: ParseError,
  zip: string | undefined,
): void {
  console.warn(
    `PARSE_SKIP_LISTING ${JSON.stringify({
      zip: zip ?? null,
      listing_index: draft.index,
      reason: err.message,
      detail: err.detail ?? null,
      forms: draft.forms.map((f) => ({
        dealerids: f.dealerIds,
        enumtypes: f.enumTypes,
        table_class: f.tableClass,
        cells: f.cells,
      })),
      meta: Object.fromEntries(draft.meta),
      html: listingHtml(html, draft.index),
    })}`,
  );
}

/**
 * Raw HTML of the index-th `div.boxlisting`, for diagnostics only: from its
 * opening tag to the next listing's (or the cap). Positions are found on the
 * comment-masked copy, which HTMLRewriter's numbering agrees with, and sliced
 * from the original so the log shows the page exactly as served.
 */
function listingHtml(html: string, index: number): string | null {
  const masked = maskNonMarkup(html);
  const lower = masked.toLowerCase();
  const starts: number[] = [];
  let i = 0;
  while (starts.length <= index + 1) {
    const at = lower.indexOf("<div", i);
    if (at === -1) break;
    const end = masked.indexOf(">", at);
    if (end === -1) break;
    const classes = attrValue(masked.slice(at, end + 1), "class") ?? "";
    if (` ${classes.toLowerCase().replace(/\s+/g, " ")} `.includes(" boxlisting ")) {
      starts.push(at);
    }
    i = end + 1;
  }
  const start = starts[index];
  if (start === undefined) return null;
  const stop = Math.min(starts[index + 1] ?? html.length, start + MAX_LOGGED_LISTING_CHARS);
  return html.slice(start, stop);
}

function parseMoney(raw: string): number | null {
  const m = MONEY.exec(norm(raw));
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Listing finalisation
// ---------------------------------------------------------------------------

function tiersFromForm(
  draft: ListingDraft,
  form: FormDraft,
  paymentType: PaymentType,
): PriceTier[] {
  const tiers: PriceTier[] = [];
  const cells = form.cells;
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const gallonsCell = norm(cells[i]!);
    const priceCell = norm(cells[i + 1]!);

    let gallonMin: number | null = null;
    let gallonMax: number | null = null;
    const range = GALLONS_RANGE.exec(gallonsCell);
    if (range) {
      gallonMin = Number(range[1]);
      gallonMax = Number(range[2]);
    } else {
      const open = GALLONS_OPEN.exec(gallonsCell);
      if (open) {
        gallonMin = Number(open[1]);
        gallonMax = null;
      }
    }

    if (gallonMin === null) {
      // Neither cell is a tier (the two header rows, the "Click to Order" row).
      // Skipping a full non-match is correct; skipping a HALF match is not.
      continue;
    }

    // Best effort: a tier whose price cannot be read is dropped and logged, and
    // the listing keeps whatever tiers it does have. A tier we cannot read is
    // never guessed at, so nothing wrong is published — only something missing.
    const price = PRICE_CELL.exec(priceCell);
    const pricePerGallon = price ? Number(price[1]!.replace(/,/g, "")) : NaN;
    if (!Number.isFinite(pricePerGallon) || pricePerGallon <= 0) {
      skip(
        `listing index ${draft.index}: ${paymentType} tier "${gallonsCell}" has ` +
          `no readable price beside it (got "${priceCell}"); tier dropped`,
      );
      continue;
    }
    if (gallonMax !== null && gallonMax < gallonMin) {
      skip(
        `listing index ${draft.index}: ${paymentType} tier "${gallonsCell}" is an ` +
          `inverted range; tier dropped`,
      );
      continue;
    }

    tiers.push({
      payment_type: paymentType,
      gallon_min: gallonMin,
      gallon_max: gallonMax,
      price_per_gallon: pricePerGallon,
    });
  }
  return tiers;
}

function finaliseListing(draft: ListingDraft): ParsedListing | null {
  const idx = draft.index;

  if (draft.forms.length !== 2) {
    throw new ParseError(
      `listing index ${idx}: expected exactly two form[action="tranction.php"] ` +
        `elements, found ${draft.forms.length}`,
      { listingIndex: idx, forms: draft.forms.length },
    );
  }

  const payments: PaymentType[] = [];
  const dealerIds: string[] = [];

  for (let f = 0; f < draft.forms.length; f++) {
    const form = draft.forms[f]!;

    if (form.dealerIds.length !== 1) {
      throw new ParseError(
        `listing index ${idx}: form ${f} has ${form.dealerIds.length} ` +
          `dealerid inputs, expected exactly 1`,
        { listingIndex: idx, form: f, count: form.dealerIds.length },
      );
    }
    if (form.enumTypes.length !== 1) {
      throw new ParseError(
        `listing index ${idx}: form ${f} has ${form.enumTypes.length} ` +
          `enumtype inputs, expected exactly 1`,
        { listingIndex: idx, form: f, count: form.enumTypes.length },
      );
    }

    const payment = normaliseEnumType(form.enumTypes[0]!);
    if (payment === null) {
      throw new ParseError(
        `listing index ${idx}: form ${f} has unrecognised enumtype ` +
          `"${form.enumTypes[0]}"`,
        { listingIndex: idx, form: f },
      );
    }
    if (form.tableClass !== null && form.tableClass !== payment) {
      throw new ParseError(
        `listing index ${idx}: form ${f} enumtype "${payment}" disagrees with ` +
          `its price table class "${form.tableClass}"`,
        { listingIndex: idx, form: f, payment, tableClass: form.tableClass },
      );
    }

    payments.push(payment);
    dealerIds.push(norm(form.dealerIds[0]!));
  }

  const cashCount = payments.filter((p) => p === "cash").length;
  const creditCount = payments.filter((p) => p === "credit").length;
  if (cashCount !== 1 || creditCount !== 1) {
    throw new ParseError(
      `listing index ${idx}: expected exactly one cash form and one credit ` +
        `form, found ${cashCount} cash and ${creditCount} credit`,
      { listingIndex: idx, payments },
    );
  }

  if (dealerIds[0] !== dealerIds[1]) {
    throw new ParseError(
      `listing index ${idx}: the two dealerid values disagree ` +
        `("${dealerIds[0]}" vs "${dealerIds[1]}")`,
      { listingIndex: idx, dealerIds },
    );
  }

  const dealerId = Number(dealerIds[0]);
  if (!Number.isInteger(dealerId) || dealerId <= 0) {
    throw new ParseError(
      `listing index ${idx}: dealerid "${dealerIds[0]}" is not a positive integer`,
      { listingIndex: idx, dealerId: dealerIds[0] },
    );
  }

  // ---- tiers -------------------------------------------------------------
  const tiers: PriceTier[] = [];
  const seen = new Set<string>();
  for (let f = 0; f < draft.forms.length; f++) {
    const form = draft.forms[f]!;
    for (const tier of tiersFromForm(draft, form, payments[f]!)) {
      const key = `${tier.payment_type}:${tier.gallon_min}`;
      if (seen.has(key)) {
        throw new ParseError(
          `listing index ${idx}: duplicate tier (${tier.payment_type}, ` +
            `gallon_min ${tier.gallon_min})`,
          { listingIndex: idx, tier },
        );
      }
      seen.add(key);
      tiers.push(tier);
    }
  }

  if (tiers.length === 0) {
    skip(`listing index ${idx}: no price tiers found`);
    return null;
  }

  // ---- listing-level metadata -------------------------------------------
  let deliveryDate: string | null = null;
  for (const form of draft.forms) {
    for (const raw of form.earliestDates) {
      const candidate = norm(raw);
      if (ISO_DATE.test(candidate)) {
        deliveryDate = candidate;
        break;
      }
    }
    if (deliveryDate !== null) break;
  }
  if (deliveryDate === null) {
    const human = draft.meta.get("delivery date");
    deliveryDate = human === undefined ? null : parseHumanDate(human);
  }

  const updatedRaw = draft.meta.get("price updated on");
  const priceUpdatedOn =
    updatedRaw === undefined ? null : parseHumanDate(updatedRaw);

  const chargeRaw = draft.meta.get("same day charges");
  const sameDayCharge = chargeRaw === undefined ? null : parseMoney(chargeRaw);

  return {
    dealer_id: dealerId,
    delivery_date: deliveryDate,
    price_updated_on: priceUpdatedOn,
    same_day_charge: sameDayCharge,
    tiers,
  };
}

// ---------------------------------------------------------------------------
// parseListingsPage
// ---------------------------------------------------------------------------

/**
 * Price-tier extraction by string scanning, deliberately NOT via HTMLRewriter.
 *
 * Profiling (see docs/cpu-measurement.md) showed the native tokenizer costs
 * 0.33ms on this page while the JS callbacks cost ~17ms — one crossing per text
 * node, and a single `td` text handler alone was ~5ms of that. The ~80 price
 * cells are the bulk of those nodes, so they are read here instead: one linear
 * pass over a string we already hold in memory, with no boundary crossings.
 *
 * PRD §9.2 chose HTMLRewriter over Cheerio on the grounds that it "runs in
 * native code rather than JS". That reasoning holds for the TOKENIZER and not
 * for handler dispatch, which is what actually dominated. Structure, hidden
 * inputs and metadata still go through HTMLRewriter; only the dense, highly
 * regular price tables are scanned.
 *
 * The markup this relies on is narrow and asserted by the fixture tests: a
 * `table` carrying class `paywithcash` or `paybycredit`, containing no nested
 * table, whose cells are plain `<td>`s. A listing that drifts from it is
 * skipped and logged as PARSE_SKIP; only a page where no listing parses at all
 * raises ParseError.
 */
interface RawPriceTable {
  payment: PaymentType;
  /** dealerid read from the SAME form region as the prices — never joined by ordinal. */
  dealerId: string | null;
  enumType: string | null;
  cells: string[];
}

/**
 * Comment / raw-text spans that must be skipped, because text inside them is
 * NOT markup. This is the difference between a scanner and a lexer, and it is
 * not theoretical: a commented-out `<td>1-1</td><td>$0.01</td>` inside a price
 * table was silently accepted as a real $0.01 price — exactly the misleading
 * cheapest-price failure the PRD exists to prevent. Hand-maintained PHP
 * comments rows out routinely.
 */
const SKIP_SPANS: Array<{ open: string; close: string }> = [
  { open: "<!--", close: "-->" },
  { open: "<script", close: "</script>" },
  { open: "<style", close: "</style>" },
];

/**
 * Blanks every comment / script / style span, preserving length.
 *
 * Blanking rather than deleting keeps every surviving offset identical to the
 * original string. One linear pass, no regex, no backtracking.
 */
function maskNonMarkup(html: string): string {
  const lower = html.toLowerCase();
  let out: string[] | null = null;
  let i = 0;

  while (i < html.length) {
    let bestStart = -1;
    let bestEnd = -1;
    for (const span of SKIP_SPANS) {
      const start = lower.indexOf(span.open, i);
      if (start === -1) continue;
      if (bestStart !== -1 && start >= bestStart) continue;
      let end = lower.indexOf(span.close, start + span.open.length);
      // An unterminated comment or script swallows the rest of the document.
      end = end === -1 ? html.length : end + span.close.length;
      bestStart = start;
      bestEnd = end;
    }
    if (bestStart === -1) break;
    if (out === null) out = html.split("");
    for (let k = bestStart; k < bestEnd; k++) out[k] = " ";
    i = bestEnd;
  }

  return out === null ? html : out.join("");
}

/** Strips tags from one cell's inner HTML, e.g. `<b>Gallons:</b>` -> `Gallons:`. */
function cellText(inner: string): string {
  return norm(inner.indexOf("<") === -1 ? inner : inner.replace(/<[^>]*>/g, ""));
}

const WS_RE = /\s/;

/**
 * Reads a tag's attribute value without a regex.
 *
 * Deliberately NOT `/attr\s*=\s*["']([^"']*)["']/`: that pattern backtracks
 * quadratically on pathological input — measured at 1.1s for an 80KB run of
 * `<table ` prefixes, and the 2MB input cap bounds bytes, not backtracking
 * time. A malformed upstream page could burn the entire CPU budget before any
 * alert could be sent. Handles quoted and unquoted values.
 */
function attrValue(tag: string, name: string): string | null {
  const lower = tag.toLowerCase();
  let i = 0;
  for (;;) {
    const at = lower.indexOf(name, i);
    if (at === -1) return null;
    // Must be preceded by whitespace so `class` does not match inside `xclass`.
    const before = at === 0 ? " " : (tag[at - 1] as string);
    let j = at + name.length;
    while (j < tag.length && WS_RE.test(tag[j] as string)) j++;
    if (!WS_RE.test(before) || tag[j] !== "=") {
      i = at + name.length;
      continue;
    }
    j++;
    while (j < tag.length && WS_RE.test(tag[j] as string)) j++;
    const quote = tag[j];
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, j + 1);
      return end === -1 ? null : tag.slice(j + 1, end);
    }
    let end = j;
    while (end < tag.length && !WS_RE.test(tag[end] as string) && tag[end] !== ">") end++;
    return tag.slice(j, end);
  }
}

/**
 * Price-tier extraction by string scanning, deliberately NOT via HTMLRewriter.
 *
 * WHY: profiling (docs/cpu-measurement.md) showed the native tokenizer costs
 * 0.33ms on this page while handing every text node to JS cost ~17ms — a single
 * `td` text handler alone was ~5ms. The ~80 price cells are the bulk of those
 * text nodes.
 *
 * WHAT MAKES IT SAFE:
 *   1. Comments, script and style spans are masked first, so text that is not
 *      markup can never become a price.
 *   2. Each price table is read from INSIDE its own `tranction.php` form, and
 *      the `dealerid` for those prices comes from that same region. Prices and
 *      dealer identity therefore travel together in one contiguous span and are
 *      never associated by ordinal position across two independent parses.
 *   3. Tag matching is case-insensitive; every scan is a linear `indexOf` walk
 *      with no backtracking regex on the hot path.
 *   4. It fails closed per table: an unterminated tag, a nested table, or an
 *      odd cell count yields NO cells for that table rather than a short one
 *      that `finaliseListing` would happily accept. The rest of the page is
 *      unaffected.
 */
export function extractPriceTables(html: string): RawPriceTable[] {
  const masked = maskNonMarkup(html);
  const lower = masked.toLowerCase();
  const tables: RawPriceTable[] = [];

  let cursor = 0;
  for (;;) {
    const formAt = lower.indexOf("<form", cursor);
    if (formAt === -1) break;
    const formTagEnd = masked.indexOf(">", formAt);
    if (formTagEnd === -1) break;
    const formTag = masked.slice(formAt, formTagEnd + 1);
    cursor = formTagEnd + 1;

    const action = attrValue(formTag, "action");
    if (action === null || !action.toLowerCase().includes("tranction.php")) continue;

    let formEnd = lower.indexOf("</form", formTagEnd);
    if (formEnd === -1) formEnd = masked.length;
    const region = masked.slice(formTagEnd + 1, formEnd);
    cursor = formEnd;

    const table = readPriceTable(region, tables.length);
    if (table !== null) tables.push(table);
  }

  return tables;
}

/** Reads the single price table inside one order form's region. */
function readPriceTable(region: string, index: number): RawPriceTable | null {
  const lower = region.toLowerCase();

  const tableAt = lower.indexOf("<table");
  if (tableAt === -1) return null;
  const tableTagEnd = region.indexOf(">", tableAt);
  if (tableTagEnd === -1) {
    skip(`price table ${index}: unterminated <table> tag; table ignored`);
    return null;
  }
  const classes = attrValue(region.slice(tableAt, tableTagEnd + 1), "class") ?? "";
  const padded = ` ${classes.toLowerCase().replace(/\s+/g, " ")} `;
  const payment: PaymentType | null = padded.includes(" paywithcash ")
    ? "cash"
    : padded.includes(" paybycredit ")
      ? "credit"
      : null;
  if (payment === null) return null;

  // A table whose cells cannot be read safely contributes no tiers at all —
  // never a truncated set — but it is still returned, so its form keeps its
  // place and the rest of the page parses normally.
  let cells: string[] = [];
  try {
    cells = readCells(region, lower, tableTagEnd, index, payment);
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    skip(`${err.message}; table ignored`);
  }

  return {
    payment,
    dealerId: hiddenInputValue(region, "dealerid"),
    enumType: hiddenInputValue(region, "enumtype"),
    cells,
  };
}

function readCells(
  region: string,
  lower: string,
  tableTagEnd: number,
  index: number,
  payment: PaymentType,
): string[] {
  const tableEnd = lower.indexOf("</table", tableTagEnd);
  if (tableEnd === -1) {
    throw new ParseError(
      `price table ${index} (${payment}) has no closing </table>`,
      { index },
    );
  }
  const body = region.slice(tableTagEnd + 1, tableEnd);
  if (body.toLowerCase().indexOf("<table") !== -1) {
    throw new ParseError(
      `price table ${index} (${payment}) contains a nested table`,
      { index },
    );
  }
  return extractCells(body, index, payment);
}

/** Value of `<input name="NAME" value="...">` within one form region. */
function hiddenInputValue(region: string, name: string): string | null {
  const lower = region.toLowerCase();
  let i = 0;
  for (;;) {
    const at = lower.indexOf("<input", i);
    if (at === -1) return null;
    const end = region.indexOf(">", at);
    if (end === -1) return null;
    const tag = region.slice(at, end + 1);
    i = end + 1;
    if ((attrValue(tag, "name") ?? "").toLowerCase() === name) {
      return attrValue(tag, "value");
    }
  }
}

function extractCells(
  tableHtml: string,
  index: number,
  payment: PaymentType,
): string[] {
  const lower = tableHtml.toLowerCase();
  const cells: string[] = [];
  let i = 0;
  for (;;) {
    const open = lower.indexOf("<td", i);
    if (open === -1) break;
    // Reject `<tdfoo`; a real cell is `<td>` or `<td ...>`.
    const after = tableHtml[open + 3];
    if (after !== undefined && after !== ">" && !WS_RE.test(after)) {
      i = open + 3;
      continue;
    }
    const gt = tableHtml.indexOf(">", open);
    if (gt === -1) {
      throw new ParseError(
        `price table ${index} (${payment}): unterminated <td> tag`,
        { index },
      );
    }
    const close = lower.indexOf("</td", gt);
    if (close === -1) {
      // Fail closed. A missing </td> used to end the loop quietly, truncating
      // the table while finaliseListing still accepted the surviving tiers.
      throw new ParseError(
        `price table ${index} (${payment}): <td> with no </td>`,
        { index },
      );
    }
    cells.push(cellText(tableHtml.slice(gt + 1, close)));
    i = close + 4;
  }
  if (cells.length % 2 !== 0) {
    throw new ParseError(
      `price table ${index} (${payment}) has an odd cell count (${cells.length}); ` +
        `the gallons/price pairing rule needs pairs`,
      { index, cells: cells.length },
    );
  }
  return cells;
}

/**
 * Best effort: listings (and individual tiers) that cannot be read are skipped
 * and logged — PARSE_SKIP_LISTING with the listing's raw HTML, PARSE_SKIP for a
 * dropped tier or table. `options.zip` only labels those log lines. Throws
 * ParseError only when the page as a whole is unusable — oversized input, or
 * listings present but none of them readable. Returns [] for a valid page with
 * no listings.
 */
export async function parseListingsPage(
  html: string,
  options: { zip?: string } = {},
): Promise<ParsedListing[]> {
  // Guard runs before any parsing work is done.
  if (typeof html !== "string") {
    throw new ParseError("parseListingsPage expects a string");
  }
  if (html.length > MAX_INPUT_BYTES) {
    throw new ParseError(
      `input of ${html.length} characters exceeds the ${MAX_INPUT_BYTES}-byte ` +
        `parser limit`,
      { length: html.length, limit: MAX_INPUT_BYTES },
    );
  }

  const listings: ParsedListing[] = [];
  const drafts: ListingDraft[] = [];
  let firstError: unknown = null;

  let listing: ListingDraft | null = null;
  let listingCount = 0;
  let form: FormDraft | null = null;

  // Chunk buffers. Each is flushed by the owning element's onEndTag handler,
  // NEVER by text.lastInTextNode (see the module docblock / plan §1.4).
  let captionBuf = "";
  let valueBuf = "";
  let pendingCaption: string | null = null;

  const fail = (err: unknown) => {
    if (firstError === null) firstError = err;
  };

  const rewriter = new HTMLRewriter()
    .on("div.boxlisting", {
      element(el) {
        listing = { index: listingCount++, forms: [], meta: new Map() };
        form = null;
        pendingCaption = null;
        el.onEndTag(() => {
          const draft = listing;
          listing = null;
          form = null;
          pendingCaption = null;
          // Finalisation is deferred: the price cells arrive from
          // extractPriceTables() after this pass completes.
          if (draft !== null) drafts.push(draft);
        });
      },
    })
    .on('form[action="tranction.php"]', {
      element(el) {
        if (listing === null) return;
        const draft = newForm();
        (listing as ListingDraft).forms.push(draft);
        form = draft;
        el.onEndTag(() => {
          form = null;
        });
      },
    })
    .on('input[name="dealerid"]', {
      element(el) {
        if (form === null) return;
        (form as FormDraft).dealerIds.push(el.getAttribute("value") ?? "");
      },
    })
    .on('input[name="enumtype"]', {
      element(el) {
        if (form === null) return;
        (form as FormDraft).enumTypes.push(el.getAttribute("value") ?? "");
      },
    })
    .on('input[name="earlistdate"]', {
      element(el) {
        if (form === null) return;
        (form as FormDraft).earliestDates.push(el.getAttribute("value") ?? "");
      },
    })
    .on("table.paywithcash", {
      element() {
        if (form !== null) (form as FormDraft).tableClass = "cash";
      },
    })
    .on("table.paybycredit", {
      element() {
        if (form !== null) (form as FormDraft).tableClass = "credit";
      },
    })
    .on("label.formtxt", {
      element(el) {
        if (listing === null) return;
        captionBuf = "";
        // Commit the WHOLE label here — one label can span several text nodes.
        el.onEndTag(() => {
          pendingCaption = captionKey(captionBuf);
          captionBuf = "";
        });
      },
      text(chunk) {
        if (listing === null) return;
        captionBuf += chunk.text;
      },
    })
    .on("label.varlabel", {
      element(el) {
        if (listing === null) return;
        valueBuf = "";
        el.onEndTag(() => {
          const draft = listing;
          const caption = pendingCaption;
          const value = norm(valueBuf);
          valueBuf = "";
          pendingCaption = null;
          if (draft !== null && caption !== null && caption !== "") {
            draft.meta.set(caption, value);
          }
        });
      },
      text(chunk) {
        if (listing === null) return;
        valueBuf += chunk.text;
      },
    });

  // Price cells are NOT read through HTMLRewriter — see extractPriceTables().
  // The table handlers stay because they are element-only and therefore cheap;
  // they record which payment table a form owns, which is then cross-checked
  // against both the hidden enumtype input and the string-scanned table order.
  rewriter.on("table.paywithcash", {
    element() {
      if (form !== null) (form as FormDraft).tableClass = "cash";
    },
  });
  rewriter.on("table.paybycredit", {
    element() {
      if (form !== null) (form as FormDraft).tableClass = "credit";
    },
  });

  // HTMLRewriter only runs against a Response body; draining it to completion
  // is what drives every handler above.
  await rewriter.transform(new Response(html)).arrayBuffer();

  if (firstError !== null) throw firstError;

  // No listings is not an error — PRD §8 leaves that call to the caller, which
  // logs and skips the day rather than writing a wrong one. Returning early
  // also avoids raising a spurious table/form mismatch on a page that has
  // price tables but no listing wrapper.
  if (drafts.length === 0) return listings;

  // Attach the string-scanned price cells.
  //
  // The scan reads each price table from inside its own `tranction.php` form and
  // carries that form's OWN dealerid and enumtype alongside the cells, so a
  // table is joined to the parsed form with the SAME (dealerid, payment type) —
  // never by bare page position. A positional join lets one listing with a
  // missing or extra table shift every later dealer's prices onto its
  // neighbour, and forced the whole page to be rejected to prevent that. Keyed,
  // a broken listing only ever costs itself.
  //
  // Should a dealer appear more than once, tables and forms sharing a key are
  // paired in document order, which both passes see identically.
  const byKey = new Map<string, RawPriceTable[]>();
  for (const table of extractPriceTables(html)) {
    if (table.dealerId === null) continue;
    const scannedType =
      table.enumType === null ? null : normaliseEnumType(table.enumType);
    if (scannedType !== null && scannedType !== table.payment) {
      skip(
        `price table for dealerid "${table.dealerId}" has enumtype ` +
          `"${scannedType}" but table class "${table.payment}"; table ignored`,
      );
      continue;
    }
    const key = `${norm(table.dealerId)}:${table.payment}`;
    const queue = byKey.get(key);
    if (queue) queue.push(table);
    else byKey.set(key, [table]);
  }

  for (const draft of drafts) {
    for (const form of draft.forms) {
      // Forms with a missing or unrecognised dealerid/enumtype get no cells;
      // finaliseListing reports exactly what is wrong and skips the listing.
      if (form.dealerIds.length !== 1 || form.enumTypes.length !== 1) continue;
      const payment = normaliseEnumType(form.enumTypes[0]!);
      if (payment === null) continue;
      const table = byKey.get(`${norm(form.dealerIds[0]!)}:${payment}`)?.shift();
      if (table !== undefined) form.cells = table.cells;
    }
  }

  // Best effort, listing by listing: an unreadable listing is skipped and
  // logged, and every other dealer on the page is still recorded.
  const skipped: ParseError[] = [];
  for (const draft of drafts) {
    try {
      const listing = finaliseListing(draft);
      if (listing !== null) {
        listings.push(listing);
      }
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      skipped.push(err);
      logSkippedListing(html, draft, err, options.zip);
    }
  }

  // ...but when NOTHING on a page with listings could be read, that is markup
  // drift across the whole site, not one odd dealer, and it must still reach
  // the operator as a ParseError.
  if (listings.length === 0) {
    const firstMsg = skipped[0]?.message ?? "no price tiers found";
    const firstDetail = skipped[0]?.detail;
    throw new ParseError(
      `none of the ${drafts.length} listing(s) could be parsed; first failure: ` +
        firstMsg,
      { listings: drafts.length, first: firstDetail },
    );
  }

  return listings;
}

// ---------------------------------------------------------------------------
// toPriceRows
// ---------------------------------------------------------------------------

/** Flattens listings into DB rows. Pure. Order: listing order, then tier order. */
export function toPriceRows(
  listings: ParsedListing[],
  zip: string,
  scrapeDate: string,
  scrapedAt: string,
): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const listing of listings) {
    for (const tier of listing.tiers) {
      rows.push({
        scrape_date: scrapeDate,
        zip,
        dealer_id: listing.dealer_id,
        payment_type: tier.payment_type,
        gallon_min: tier.gallon_min,
        gallon_max: tier.gallon_max,
        price_per_gallon: tier.price_per_gallon,
        delivery_date: listing.delivery_date,
        price_updated_on: listing.price_updated_on,
        same_day_charge: listing.same_day_charge,
        scraped_at: scrapedAt,
      });
    }
  }
  return rows;
}
