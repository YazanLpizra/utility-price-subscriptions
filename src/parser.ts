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
const GALLONS_RANGE = /^(\d+)\s*-\s*(\d+)\s*\+?$/;
const GALLONS_OPEN = /^(\d+)\s*\+$/;
const PRICE_CELL = /^\$\s*([\d,]+\.\d{2})$/;
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

    const price = PRICE_CELL.exec(priceCell);
    if (!price) {
      throw new ParseError(
        `listing index ${draft.index}: ${paymentType} tier "${gallonsCell}" has ` +
          `no valid price cell beside it (got "${priceCell}") — refusing to ` +
          `silently drop a tier that could be the cheapest price`,
        { listingIndex: draft.index, paymentType, gallonsCell, priceCell },
      );
    }
    const pricePerGallon = Number(price[1]!.replace(/,/g, ""));
    if (!Number.isFinite(pricePerGallon)) {
      throw new ParseError(
        `listing index ${draft.index}: ${paymentType} tier "${gallonsCell}" has ` +
          `an unreadable price "${priceCell}"`,
        { listingIndex: draft.index, paymentType, priceCell },
      );
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

function finaliseListing(draft: ListingDraft): ParsedListing {
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
    throw new ParseError(`listing index ${idx}: no price tiers found`, {
      listingIndex: idx,
      dealerId,
    });
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
 * Throws ParseError on a structurally broken page.
 * Returns [] for a valid page with no listings.
 */
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
 * table, whose cells are plain `<td>`s. Drift is caught by the tier-count and
 * pairing rules in finaliseListing(), which raise ParseError rather than
 * silently returning fewer prices.
 */
interface RawPriceTable {
  payment: PaymentType;
  cells: string[];
}

const PRICE_TABLE_OPEN = /<table\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi;

/** Strips tags from one cell's inner HTML, e.g. `<b>Gallons:</b>` -> `Gallons:`. */
function cellText(inner: string): string {
  return norm(inner.indexOf("<") === -1 ? inner : inner.replace(/<[^>]*>/g, ""));
}

function extractCells(tableHtml: string): string[] {
  const cells: string[] = [];
  let i = 0;
  for (;;) {
    const open = tableHtml.indexOf("<td", i);
    if (open === -1) break;
    const gt = tableHtml.indexOf(">", open);
    if (gt === -1) break;
    const close = tableHtml.indexOf("</td", gt);
    if (close === -1) break;
    cells.push(cellText(tableHtml.slice(gt + 1, close)));
    i = close + 4;
  }
  return cells;
}

/** Every cash/credit price table in document order. */
export function extractPriceTables(html: string): RawPriceTable[] {
  const tables: RawPriceTable[] = [];
  PRICE_TABLE_OPEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PRICE_TABLE_OPEN.exec(html)) !== null) {
    const classes = match[1] ?? "";
    const payment: PaymentType | null = /\bpaywithcash\b/i.test(classes)
      ? "cash"
      : /\bpaybycredit\b/i.test(classes)
        ? "credit"
        : null;
    if (payment === null) continue;

    const bodyStart = PRICE_TABLE_OPEN.lastIndex;
    const bodyEnd = html.indexOf("</table", bodyStart);
    if (bodyEnd === -1) {
      throw new ParseError(
        `price table ${tables.length} (${payment}) has no closing </table>`,
        { tableIndex: tables.length },
      );
    }
    const body = html.slice(bodyStart, bodyEnd);
    // The pairing rule assumes a flat table. A nested table would make
    // `</table>` land in the wrong place, so refuse rather than mis-pair.
    if (body.indexOf("<table") !== -1) {
      throw new ParseError(
        `price table ${tables.length} (${payment}) contains a nested table`,
        { tableIndex: tables.length },
      );
    }
    tables.push({ payment, cells: extractCells(body) });
  }
  return tables;
}

export async function parseListingsPage(
  html: string,
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

  // Attach the string-scanned price cells. Each form contains exactly one price
  // table, and both appear in document order, so the Nth table belongs to the
  // Nth form. That correspondence is asserted rather than assumed.
  const tables = extractPriceTables(html);
  const formsInOrder: FormDraft[] = [];
  for (const draft of drafts) formsInOrder.push(...draft.forms);

  if (tables.length !== formsInOrder.length) {
    throw new ParseError(
      `found ${tables.length} price table(s) but ${formsInOrder.length} order ` +
        `form(s); the two must correspond one to one`,
      { tables: tables.length, forms: formsInOrder.length },
    );
  }

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i] as RawPriceTable;
    const target = formsInOrder[i] as FormDraft;
    // The table's own class must agree with the class HTMLRewriter saw on the
    // element it matched. A mismatch means the two passes disagree about
    // document order, which would silently file prices under the wrong dealer.
    if (target.tableClass !== null && target.tableClass !== table.payment) {
      throw new ParseError(
        `price table ${i} is "${table.payment}" but the form's table element ` +
          `was "${target.tableClass}"; the scan and the parse disagree on order`,
        { tableIndex: i },
      );
    }
    target.cells = table.cells;
  }

  for (const draft of drafts) {
    listings.push(finaliseListing(draft));
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
