/**
 * Global test setup, applied to EVERY test file by vitest.config.ts.
 *
 * Two responsibilities:
 *   1. apply migrations/0001_init.sql to the local D1 for this test file;
 *   2. reset the database before every single `it()`.
 *
 * (2) is not optional. `@cloudflare/vitest-plugin@1.1.4` isolates storage
 * PER TEST FILE, not per test — inside one file, writes survive from one
 * `it()` to the next. Registering the reset here rather than in an individual
 * test file means no phase has to remember to do it, and no phase can be
 * broken by another phase forgetting.
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch([
    // Children before parents: prices/subscriptions/notifications carry FKs,
    // and D1 enforces foreign keys by default.
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM prices"),
    env.DB.prepare("DELETE FROM subscriptions"),
    env.DB.prepare("DELETE FROM zips"),
    // DELETE does not reset AUTOINCREMENT counters, so without this the ids
    // handed out by `prices` and `subscriptions` depend on test order.
    env.DB.prepare(
      "DELETE FROM sqlite_sequence WHERE name IN ('prices','subscriptions')",
    ),
  ]);
});
