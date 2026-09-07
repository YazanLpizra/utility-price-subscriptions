#!/usr/bin/env node
/**
 * Local seeding and small admin operations for the heating-oil tracker.
 *
 * A NOTE ON INJECTION, because it is the whole reason this file is careful:
 * `wrangler d1 execute` takes a SQL *string*. It has no bound-parameter
 * interface. So every value that reaches SQL here is first validated against a
 * strict grammar, and rejected outright — with no SQL issued at all — if it
 * does not match. Quote-escaping is applied on top of that as a second line of
 * defence, not as the primary one.
 *
 * Usage:
 *   node scripts/seed.mjs                       apply seeds/dev-seed.sql locally
 *   node scripts/seed.mjs --dry-run             print the SQL and exit, touching nothing
 *   node scripts/seed.mjs --remote              apply remotely (needs CONFIRM_REMOTE=1)
 *   node scripts/seed.mjs --add-zip 06611
 *   node scripts/seed.mjs --activate 06611
 *   node scripts/seed.mjs --deactivate 06611
 *   node scripts/seed.mjs --add-sub <zip> <chat-id> <min_gallons> <cash|credit> [threshold]
 *   node scripts/seed.mjs --help
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "heating-oil";
const SEED_FILE = join(ROOT, "seeds", "dev-seed.sql");

// --------------------------------------------------------------- validation

const ZIP_RE = /^\d{5}$/;
/** A Telegram chat id: digits, optionally negative for groups and channels. */
const DESTINATION_RE = /^-?[1-9]\d{0,18}$/;
/** Telegram ids fit in 52 significant bits; the CLI must not approve what the API will reject. */
const MAX_CHAT_ID = 2n ** 52n;
const THRESHOLD_RE = /^\d+(\.\d{1,2})?$/;
const PAYMENT_TYPES = new Set(["cash", "credit"]);
const MAX_GALLONS = 100000;

class UsageError extends Error {}

function validZip(value) {
  if (typeof value !== "string" || !ZIP_RE.test(value)) {
    throw new UsageError(`invalid zip ${JSON.stringify(value ?? "")}: expected 5 digits`);
  }
  return value;
}

function validDestination(value) {
  const inRange = (v) => {
    try {
      const magnitude = BigInt(v.startsWith("-") ? v.slice(1) : v);
      return magnitude > 0n && magnitude < MAX_CHAT_ID;
    } catch {
      return false;
    }
  };
  if (typeof value !== "string" || !DESTINATION_RE.test(value) || !inRange(value)) {
    throw new UsageError(
      `invalid destination ${JSON.stringify(value ?? "")}: expected a Telegram chat id (digits, optionally negative)`,
    );
  }
  return value;
}

function validGallons(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new UsageError(`invalid gallons ${JSON.stringify(value ?? "")}: expected an integer`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_GALLONS) {
    throw new UsageError(`invalid gallons ${value}: expected 1..${MAX_GALLONS}`);
  }
  return n;
}

function validPaymentType(value) {
  if (!PAYMENT_TYPES.has(value)) {
    throw new UsageError(
      `invalid payment type ${JSON.stringify(value ?? "")}: expected cash or credit`,
    );
  }
  return value;
}

function validThreshold(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !THRESHOLD_RE.test(value)) {
    throw new UsageError(
      `invalid threshold ${JSON.stringify(value)}: expected a positive decimal with at most 2 dp`,
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`invalid threshold ${value}: must be greater than 0`);
  }
  return n;
}

/** Belt and braces. Every string reaching here has already passed a grammar. */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// --------------------------------------------------------------- wrangler

/**
 * Resolve wrangler's JS entrypoint and run it with the current Node binary.
 *
 * Not `npx`, and not a bare `wrangler`: on Windows those resolve to
 * `wrangler.cmd`, which Node 24 refuses to spawnSync without `shell: true`
 * (EINVAL). Using a shell would also push our SQL through shell quoting, which
 * is exactly what this script is built to avoid. Resolving the .js directly is
 * cross-platform and keeps the argument vector intact.
 */
function wranglerEntry() {
  // wrangler's package.json `exports` map does not expose bin/wrangler.js, so
  // require.resolve() on that deep path fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
  // Walk up from this script looking for the installed binary instead.
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
    "could not find wrangler; run `npm install`. Looked in:\n  " +
      candidates.join("\n  "),
  );
}

function runWrangler(args, { dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] wrangler ${args.join(" ")}`);
    return { status: 0, stdout: "" };
  }
  const result = spawnSync(process.execPath, [wranglerEntry(), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function execSql(sql, opts) {
  const args = ["d1", "execute", DB_NAME, opts.remote ? "--remote" : "--local", "--command", sql];
  if (opts.dryRun) {
    console.log(sql);
    return 0;
  }
  return runWrangler(args, { dryRun: false }).status;
}

function execFile(path, opts) {
  const args = ["d1", "execute", DB_NAME, opts.remote ? "--remote" : "--local", "--file", path];
  if (opts.dryRun) {
    console.log(readFileSync(path, "utf8"));
    return 0;
  }
  return runWrangler(args, { dryRun: false }).status;
}

// --------------------------------------------------------------- commands

function addZipSql(zip) {
  return (
    `INSERT INTO zips (zip, slug, city, state, active, slug_resolved_at) ` +
    `VALUES (${sqlString(zip)}, NULL, NULL, NULL, 0, NULL) ` +
    `ON CONFLICT (zip) DO NOTHING;`
  );
}

function setActiveSql(zip, active) {
  return `UPDATE zips SET active = ${active} WHERE zip = ${sqlString(zip)};`;
}

function addSubSql(zip, topic, gallons, payment, threshold) {
  const t = threshold === null ? "NULL" : String(threshold);
  return (
    `INSERT INTO subscriptions ` +
    `(user_id, zip, destination, min_gallons, payment_type, threshold, active) ` +
    `VALUES ('v1', ${sqlString(zip)}, ${sqlString(topic)}, ${gallons}, ` +
    `${sqlString(payment)}, ${t}, 1) ` +
    `ON CONFLICT (user_id, zip, destination, payment_type, min_gallons) DO UPDATE SET ` +
    `threshold = excluded.threshold, active = excluded.active;`
  );
}

const HELP = `heating-oil tracker — local seed / admin

  node scripts/seed.mjs                    apply seeds/dev-seed.sql to local D1
  node scripts/seed.mjs --dry-run          print SQL, touch nothing, exit 0
  node scripts/seed.mjs --remote           apply remotely (requires CONFIRM_REMOTE=1)

  --add-zip <zip>                          add a zip, INACTIVE
  --activate <zip>                         activate a zip (causes real fetches!)
  --deactivate <zip>                       pause a zip, keeping its history
  --add-sub <zip> <chat-id> <gallons> <cash|credit> [threshold]

Every zip in the dev seed is INACTIVE, so a local run reaches no network.
Validation grammars: zip 5 digits; destination a Telegram chat id; gallons an
integer 1..${MAX_GALLONS}; payment cash|credit; threshold positive, <= 2 dp.
`;

function parseArgs(argv) {
  const opts = { dryRun: false, remote: false, command: null, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--remote") opts.remote = true;
    else if (a === "--help" || a === "-h") opts.command = "help";
    else if (a === "--add-zip" || a === "--activate" || a === "--deactivate") {
      opts.command = a;
      opts.args = [argv[++i]];
    } else if (a === "--add-sub") {
      opts.command = a;
      opts.args = argv.slice(i + 1, i + 6);
      i += opts.args.length;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(String(e.message ?? e));
    return 2;
  }

  if (opts.command === "help") {
    console.log(HELP);
    return 0;
  }

  if (opts.remote && process.env.CONFIRM_REMOTE !== "1") {
    console.error(
      "refusing to touch the remote database: set CONFIRM_REMOTE=1 to confirm.",
    );
    return 2;
  }

  // Validate BEFORE any SQL is produced or issued.
  let sql = null;
  try {
    switch (opts.command) {
      case "--add-zip":
        sql = addZipSql(validZip(opts.args[0]));
        break;
      case "--activate":
        sql = setActiveSql(validZip(opts.args[0]), 1);
        break;
      case "--deactivate":
        sql = setActiveSql(validZip(opts.args[0]), 0);
        break;
      case "--add-sub": {
        const [zip, topic, gallons, payment, threshold] = opts.args;
        sql = addSubSql(
          validZip(zip),
          validDestination(topic),
          validGallons(gallons),
          validPaymentType(payment),
          validThreshold(threshold),
        );
        break;
      }
      default:
        sql = null;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\nNo SQL was issued.`);
      return 2;
    }
    throw e;
  }

  const status =
    sql === null ? execFile(SEED_FILE, opts) : execSql(sql, opts);

  if (status !== 0) return status;

  if (!opts.dryRun && sql === null) {
    console.log("\nseeded. current counts:");
    execSql(
      "SELECT (SELECT COUNT(*) FROM zips) AS zips, " +
        "(SELECT COUNT(*) FROM zips WHERE active = 1) AS active_zips, " +
        "(SELECT COUNT(*) FROM subscriptions) AS subscriptions;",
      opts,
    );
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
