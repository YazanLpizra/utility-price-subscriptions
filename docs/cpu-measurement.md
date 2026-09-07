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
require enabling `nodejs_compat`, which this project does not otherwise need. If CPU pressure ever
does force a redesign, the fix is splitting the parse work across invocations, not changing
parsers.

## Results

| date | environment | median ms | p95 ms | notes |
|---|---|---|---|---|
| | local (workerd, `performance.now()`) | | | |
| | production (Workers observability, queue consumer) | | | |

This document blocks no phase. The local numbers above are filled in by whoever runs the
in-process measurement; the authoritative production row is filled in once this project is
deployed and a real scheduled run has executed, judged against the decision rule above.
