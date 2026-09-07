# CPU measurement procedure (PRD §9.2 action item)

## The unresolved risk, stated plainly

`docs/heating-oil-tracker-prd.md` §9 concludes that this project runs on the Cloudflare Workers
free tier "with a wide margin," and every line of its capacity table (§9.1) is safe on arithmetic
alone **except one: CPU time per invocation against the 10 ms free-tier ceiling.** That number has
never been measured against production traffic. It is an **accepted, unresolved risk** for the
whole build — not a settled fact — and it stays unresolved until it is measured in production
after deploy. HTMLRewriter was chosen over Cheerio specifically because it runs natively rather
than building a JS DOM (§9.2), which is a strong reason to expect it lands comfortably under
budget, but "strong reason to expect" is not a measurement.

This document is the procedure for closing that gap. It is not itself a gate on any phase before
deploy — the local numbers below are indicative, filled in here, and the authoritative number is
filled in once this project is deployed and a real invocation has run, judged against the
decision rule below.

## 1. Indicative local measurement — a workerd CPU profile via DevTools

This is the honest local method. **`wrangler dev`'s request log does not report a CPU-time
figure** — there is no such feature — so do not look for one there.

1. Run `npx wrangler dev` (no flags needed for this).
2. `wrangler dev` prints a DevTools inspector URL (or opens it automatically, depending on your
   terminal) — open it in Chrome/Edge. This attaches to the actual workerd isolate running your
   code, not a Node.js approximation.
3. In the DevTools **Performance** panel, start a CPU profile (the record button).
4. Trigger the handler you want to measure — for this project, hit
   `http://127.0.0.1:8787/__scheduled?cron=0+12+*+*+*` with at least one active zip seeded (see
   the README's opt-in warning: this will cause a real outbound fetch, since parsing needs real
   HTML to chew on — plan for that, or feed it the local fixture via a temporary test route).
5. Stop the profile.
6. In the flame chart / bottom-up view, find the frames inside `parseListingsPage` and its
   HTMLRewriter callbacks, and read their **self time** (not wall-clock time — wall-clock includes
   waiting on the network fetch and D1, which do not count against the CPU-time budget).
7. Repeat 10 times and record the median self time.

**Caveat, stated plainly:** a local workerd profile on a developer laptop is *indicative, not
authoritative*. It runs on different hardware than Cloudflare's edge, under no contention from
other tenants, and workerd's local CPU accounting is not guaranteed to match the production
metering exactly. Use it to catch gross regressions early, not to sign off on the free-tier claim.

## 2. In-process measurement: `performance.now()` around the parser alone

This is the most repeatable local number, and the one to track over time, because it isolates
parse cost from I/O (network fetch latency, D1 round-trips) entirely. Run it via `npx vitest run`
against the committed fixture:

```ts
// Ad-hoc — paste into a scratch test file, or run interactively; not committed as a
// permanent test since it asserts nothing, only measures.
import { readFileSync } from "node:fs";
import { parseListingsPage } from "../src/parser";

const fixture = readFileSync("test/fixtures/06483.html", "utf8");

const samples: number[] = [];
for (let i = 0; i < 50; i++) {
  const start = performance.now();
  await parseListingsPage(fixture);
  samples.push(performance.now() - start);
}

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const p95 = samples[Math.floor(samples.length * 0.95)];
console.log(`parseListingsPage(fixture): median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
```

Notes:

- Run this inside the Workers pool (`npx vitest run`), not plain Node — `parseListingsPage` uses
  the global `HTMLRewriter`, which only exists in the workerd runtime the Cloudflare vitest plugin
  provides. A plain Node run will throw `HTMLRewriter is not defined`.
- Discard the first few samples if you want to exclude JIT warm-up; the fixture is ~33 KB and
  parses in well under a millisecond of wall time in ad-hoc local runs, but wall time is not CPU
  time and is not a substitute for either measurement in this document.
- This measures parse cost only — it deliberately excludes `fetchPricesPage`, `writePriceRows`,
  and `sendNtfy`, none of which consume CPU time while awaiting I/O.

## 3. Authoritative measurement: Workers observability

The only figure that actually settles the question is the CPU-time metric for the **queue
consumer** (`queue()`, which is where `parseListingsPage` and the D1 writes run) as reported by
Cloudflare after a real deploy — via the Workers Logs / Observability panel in the Cloudflare
dashboard, or via `wrangler tail` while a real invocation runs. `observability: { enabled: true }`
is already set in `wrangler.jsonc` precisely so this is available from the first deploy.

This document does not claim to have run that measurement — it is the deploy phase's job to read
it and record it below, against the decision rule in the next section.

## Decision rule

Applied to the median parse CPU time from the authoritative (production) measurement:

| Median parse CPU | Action |
|---|---|
| **< 3 ms** | Settled. HTMLRewriter is comfortably within the 10 ms budget; no change needed. |
| **3–7 ms** | Keep HTMLRewriter, but re-measure before adding more zips or growing the fixture's dealer count — the margin is real but not large. |
| **> 7 ms** | Too close to the 10 ms ceiling to be comfortable. Open a follow-up to split parsing across more than one message (e.g. per-listing rather than per-zip), rather than trying to shave the existing implementation. |

**Cheerio stays rejected regardless of where the number lands.** Even a comfortable HTMLRewriter
number does not reopen that choice, and an uncomfortable one is even less of a reason to switch:
Cheerio builds a full DOM in JS (strictly more CPU per byte, not less) and would additionally
require enabling `nodejs_compat`, which this project does not otherwise need.

## Where the CPU actually went — and what to do if we hit the limit again

**Read this first if CPU ever becomes a problem again.** The original guidance here said the fix
would be "splitting the parse work across invocations, not changing parsers." That turned out to be
wrong, and measurement is what showed it.

Profiled against the real fixture inside workerd:

| step | cost |
|---|---|
| drain the response body, no parsing | 0.20 ms |
| `HTMLRewriter` with **zero** handlers | **0.33 ms** |
| + one element-only selector | 0.63 ms |
| + one `td` **text** handler (~80 cells) | **5.47 ms** |
| full parse, 11 selectors, 4 with text handlers | 17.13 ms |

The native tokenizer is essentially free. Practically all of the cost was **one JS callback per text
node** — dispatch across the runtime/JS boundary, not parsing. That qualifies PRD §9.2: its claim
that HTMLRewriter wins because it "runs in native code rather than JS" is true of the tokenizer and
false of handler dispatch, which is what dominated.

So the fix was neither splitting work nor swapping in Cheerio. It was to stop routing ~80 dense,
highly regular price cells through text handlers, and read them with a single linear string scan of
the body we already hold in memory (`extractPriceTables()` in `src/parser.ts`).

**If CPU pressure returns, investigate the string-scanning mechanism first.** Concretely:

1. **Re-profile before optimising.** The table above is the method: time `HTMLRewriter` with no
   handlers, then add selectors one at a time. Cost tracks the number of text-node callbacks, not
   document size.
2. **The remaining budget is the metadata label handlers.** `label.formtxt` and `label.varlabel`
   still use text handlers and are now the largest remaining item in the ~7.6 ms parse. They can be
   moved to the same string-scanning approach — scan each listing's region for the caption/value
   pairs — which is the obvious next win if one is needed.
3. **Extend the scan, do not replace the parser wholesale.** HTMLRewriter still earns its place for
   structure: listings, order forms, and hidden inputs are element-only handlers and cheap. Keeping
   it there preserves real HTML parsing for the parts where markup drift is most likely to matter.
4. **Keep the cross-checks.** String scanning is more brittle than a parser, so the correspondence
   between scanned tables and parsed forms is asserted (counts must match, and each table's class
   must agree with the class HTMLRewriter saw). Any further scanning must come with equivalent
   assertions, or drift will silently produce wrong prices instead of a `ParseError`.
5. **Only then consider the alternatives.** Splitting across invocations does not help, because the
   parse cannot be split. WASM does not help either: HTMLRewriter is already native Rust (lol-html)
   inside workerd, so a WASM parser would duplicate it at a bundle-size and instantiation cost while
   still paying boundary crossings. The certain non-code fix is the Workers Paid plan, which raises
   the ceiling from 10 ms to a 30 s default.

## Results

| date | environment | median ms | p95 ms | notes |
|---|---|---|---|---|
| 2026-09-06 | local (workerd, `performance.now()`) | 19.0 | 23.0 | original parser, all cells via HTMLRewriter text handlers |
| 2026-09-06 | production (`wrangler tail`, queue consumer) | 12–16 | — | same build; **over the 10 ms free-tier ceiling**, though runs completed `outcome: ok` |
| 2026-09-06 | production (`wrangler tail`, cron producer) | 2 | — | producer only enqueues; never the constraint |
| 2026-09-06 | local (workerd, `performance.now()`) | 16.0 | 20.0 | after removing ~80 per-cell `onEndTag` closures and single-passing `norm()` — only ~16%, which is what prompted the profile above |
| 2026-09-06 | local (workerd, `performance.now()`) | **7.62** | — | after moving price cells to `extractPriceTables()`; the scan itself is **0.13 ms** vs ~11 ms of handler dispatch |

This document blocks no phase. The local numbers above are filled in by whoever runs the
in-process measurement; the authoritative production row is filled in once this project is
deployed and a real scheduled run has executed, judged against the decision rule above.
