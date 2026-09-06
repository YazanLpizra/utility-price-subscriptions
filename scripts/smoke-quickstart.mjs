#!/usr/bin/env node
/**
 * Phase 8's real validation gate.
 *
 * Runs every command in the README's "Local quickstart" section, in order, as
 * separate child processes, and fails loudly if any of them exits non-zero.
 * This is the executable proof that a clean checkout actually reaches a green
 * `npm test` by following the README verbatim — not a claim about it.
 *
 * Two commands (`npm run migrate:local`, `npm run seed:local`) write to D1's
 * local persistence directory (`.wrangler/state` by default). To avoid
 * clobbering whatever the developer already has seeded there, this script
 * runs the SAME underlying commands the npm scripts run, but against a
 * throwaway `--persist-to` directory created in the OS temp dir and deleted
 * when the script exits — success, failure, or an uncaught throw.
 *
 * `npm install` is deliberately NOT one of the four commands run here: it
 * requires `node_modules` to already exist for THIS script to run at all
 * (it needs `wrangler` and `vitest` installed), and it needs the network.
 * Everything this script does needs is fully offline (README's quickstart
 * promise), which is asserted implicitly by never calling `fetch` here and
 * explicitly by the seeded-zip-count assertion below (zero active zips ->
 * nothing the Worker's own code does would call out to the network either).
 *
 * Wrangler is resolved and run the same way `scripts/seed.mjs` does: find
 * `node_modules/wrangler/bin/wrangler.js` and run it with `process.execPath`.
 * Not `npx`, and not a bare `wrangler` — on Windows those resolve to
 * `wrangler.cmd`, which Node 24 refuses to `spawnSync` without `shell: true`
 * (EINVAL), and a shell would reintroduce quoting problems this script has no
 * need for.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "heating-oil";

// --------------------------------------------------------------- resolution

/**
 * Resolve wrangler's JS entrypoint by walking up from this script. Mirrors
 * `scripts/seed.mjs`'s `wranglerEntry()` exactly, for the same reason: wrangler's
 * package.json `exports` map does not expose `bin/wrangler.js`, so
 * `require.resolve()` on that path fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 */
function wranglerEntry() {
  const candidates = [];
  let dir = ROOT;
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, "node_modules", "wrangler", "bin", "wrangler.js"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "could not find wrangler; run `npm install`. Looked in:\n  " + candidates.join("\n  "),
  );
}

/** Same reasoning as `wranglerEntry()`: resolve vitest's own entry point rather
 *  than spawning the `vitest` / `vitest.cmd` shim. */
function vitestEntry() {
  const candidate = join(ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(candidate)) {
    throw new Error(`could not find vitest at ${candidate}; run \`npm install\`.`);
  }
  return candidate;
}

// --------------------------------------------------------------- running

/**
 * Runs one command as its own child process (never a shell chain), via
 * `process.execPath` on a resolved .js entry point, and prints the command and
 * its exit code before returning it. Never throws on a non-zero exit — the
 * caller decides what that means.
 */
function run(label, execArgs) {
  const displayCommand = `node ${execArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
  console.log(`\n--- ${label} ---`);
  console.log(`$ ${displayCommand}`);
  const result = spawnSync(process.execPath, execArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  const code = result.status ?? 1;
  console.log(`exit code: ${code}`);
  return code;
}

/** Same shape as `run`, but captures stdout instead of inheriting it, for the
 *  JSON count query. */
function runCapture(label, execArgs) {
  console.log(`\n--- ${label} ---`);
  console.log(`$ node ${execArgs.join(" ")}`);
  const result = spawnSync(process.execPath, execArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
  });
  if (result.error) throw result.error;
  const code = result.status ?? 1;
  console.log(`exit code: ${code}`);
  return { code, stdout: result.stdout ?? "" };
}

// --------------------------------------------------------------- main

function main() {
  const persistDir = mkdtempSync(join(tmpdir(), "heating-oil-smoke-"));
  console.log(`Using throwaway D1 persistence directory: ${persistDir}`);

  /** @type {{ label: string; code: number }[]} */
  const outcomes = [];
  let countsOk = false;

  try {
    // 1. `npm run fixture` -> `node scripts/extract-fixture.mjs`. Reads only the
    // local view-source capture in docs/; touches no D1 state, no network.
    outcomes.push({
      label: "npm run fixture",
      code: run("fixture", [join(ROOT, "scripts", "extract-fixture.mjs")]),
    });

    // 2. `npm run migrate:local` -> `wrangler d1 migrations apply heating-oil
    // --local`, with --persist-to pointed at the throwaway directory so the
    // developer's own local D1 state is never touched by running this smoke test.
    outcomes.push({
      label: "npm run migrate:local",
      code: run("migrate:local", [
        wranglerEntry(),
        "d1",
        "migrations",
        "apply",
        DB_NAME,
        "--local",
        "--persist-to",
        persistDir,
      ]),
    });

    // 3. `npm run seed:local` -> `node scripts/seed.mjs`, which with no flags
    // applies seeds/dev-seed.sql via `wrangler d1 execute ... --file`. seed.mjs
    // itself has no --persist-to passthrough (its argument grammar is for admin
    // flags, not wrangler flags), so this step runs the same underlying wrangler
    // command seed.mjs would run, against the same throwaway directory.
    outcomes.push({
      label: "npm run seed:local",
      code: run("seed:local", [
        wranglerEntry(),
        "d1",
        "execute",
        DB_NAME,
        "--local",
        "--persist-to",
        persistDir,
        "--file",
        join(ROOT, "seeds", "dev-seed.sql"),
      ]),
    });

    // Assert the seeded counts the phase brief requires: 4 zips, 0 active, 2
    // subscriptions. This is the check that actually proves the seed applied
    // correctly, not just that wrangler exited 0.
    const countQuery =
      "SELECT (SELECT COUNT(*) FROM zips) AS zips, " +
      "(SELECT COUNT(*) FROM zips WHERE active = 1) AS active_zips, " +
      "(SELECT COUNT(*) FROM subscriptions) AS subscriptions;";
    const countResult = runCapture("assert seeded counts", [
      wranglerEntry(),
      "d1",
      "execute",
      DB_NAME,
      "--local",
      "--persist-to",
      persistDir,
      "--command",
      countQuery,
      "--json",
    ]);
    outcomes.push({ label: "assert seeded counts (query)", code: countResult.code });

    if (countResult.code === 0) {
      let counts = null;
      try {
        const parsed = JSON.parse(countResult.stdout);
        counts = Array.isArray(parsed) ? parsed[0]?.results?.[0] : null;
      } catch (err) {
        console.error(`could not parse wrangler --json output: ${String(err)}`);
      }
      if (
        counts &&
        counts.zips === 4 &&
        counts.active_zips === 0 &&
        counts.subscriptions === 2
      ) {
        countsOk = true;
        console.log(
          `PASS  seeded counts match: zips=${counts.zips} active_zips=${counts.active_zips} ` +
            `subscriptions=${counts.subscriptions}`,
        );
      } else {
        console.error(
          `FAIL  seeded counts do not match expected {zips:4, active_zips:0, subscriptions:2}; ` +
            `got ${JSON.stringify(counts)}`,
        );
      }
    }
    outcomes.push({ label: "assert seeded counts (values)", code: countsOk ? 0 : 1 });

    // 4. `npm test` -> `vitest run`. Runs against the Cloudflare vitest plugin's
    // OWN ephemeral D1 and workerd instances (per test file, applied fresh by
    // test/setup.ts) — entirely separate from the --persist-to directory above —
    // and every test that would otherwise touch the network injects a stub
    // `fetchImpl`, so this issues no real request either.
    outcomes.push({
      label: "npm test",
      code: run("test", [vitestEntry(), "run"]),
    });
  } finally {
    try {
      rmSync(persistDir, { recursive: true, force: true });
      console.log(`\nCleaned up ${persistDir}`);
    } catch (err) {
      console.error(`warning: failed to remove ${persistDir}: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------- summary

  console.log("\n=== smoke test summary ===");
  let allPassed = true;
  for (const { label, code } of outcomes) {
    const status = code === 0 ? "PASS" : "FAIL";
    if (code !== 0) allPassed = false;
    console.log(`${status}  ${label} (exit ${code})`);
  }

  if (allPassed) {
    console.log("\nPASS — every README quickstart step succeeded, offline, against a throwaway D1.");
    return 0;
  }
  console.error("\nFAIL — see the non-zero exit codes above.");
  return 1;
}

process.exit(main());
