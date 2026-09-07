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
  let firstError: unknown = null;

  let listing: ListingDraft | null = null;
  let listingCount = 0;
  let form: FormDraft | null = null;

  // Chunk buffers. Each is flushed by the owning element's onEndTag handler,
  // NEVER by text.lastInTextNode (see the module docblock / plan §1.4).
  let captionBuf = "";
  let valueBuf = "";
  let cellBuf = "";
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
          if (draft === null) return;
          try {
            listings.push(finaliseListing(draft));
          } catch (err) {
            fail(err);
          }
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

  // Cell buffering WITHOUT a per-cell onEndTag.
  //
  // A results page has ~80 price-table cells, and registering an onEndTag on
  // each one allocated ~80 closures per parse — which profiling showed to be
  // the dominant cost of the whole consumer (the parse is ~19ms of a ~19ms
  // budget; row-building and D1 are free by comparison).
  //
  // Instead a cell is flushed when the NEXT cell opens, and the final cell of a
  // table is flushed by that table's end tag. There are 10 tables per page
  // versus 80 cells, so this trades ~80 closures for ~10. Cell order within a
  // table is preserved, which is all the pairing rule in §1.2 depends on.
  let cellOpen = false;

  const flushCell = () => {
    if (!cellOpen) return;
    cellOpen = false;
    const target = form;
    const value = norm(cellBuf);
    cellBuf = "";
    if (target !== null) (target as FormDraft).cells.push(value);
  };

  const cellHandlers = {
    element() {
      if (form === null) return;
      flushCell(); // close the previous cell, if any
      cellOpen = true;
      cellBuf = "";
    },
    text(chunk: Text) {
      if (form === null || !cellOpen) return;
      cellBuf += chunk.text;
    },
  };

  const tableHandlers = (payment: PaymentType) => ({
    element(el: Element) {
      if (form !== null) (form as FormDraft).tableClass = payment;
      // Flush the table's last cell; nothing else closes it.
      el.onEndTag(() => {
        flushCell();
      });
    },
  });

  rewriter.on("table.paywithcash", tableHandlers("cash"));
  rewriter.on("table.paybycredit", tableHandlers("credit"));
  rewriter.on("table.paywithcash td", cellHandlers);
  rewriter.on("table.paybycredit td", cellHandlers);

  // HTMLRewriter only runs against a Response body; draining it to completion
  // is what drives every handler above.
  await rewriter.transform(new Response(html)).arrayBuffer();

  if (firstError !== null) throw firstError;
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
