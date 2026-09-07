import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // ALERT_DESTINATION is deliberately NOT a var in wrangler.jsonc: a
          // plain var there shares the binding namespace with secrets and
          // overwrites `wrangler secret put` on every deploy. In production it
          // is a secret; here it is a test-only binding.
          ALERT_DESTINATION: "9999999999",
          NOTIFY_PROVIDER: "telegram",
          TELEGRAM_BOT_TOKEN: "123:TESTTOKEN",
          TELEGRAM_API_BASE: "https://api.telegram.org",
          // Tests always exercise the PRODUCTION dedupe behaviour, regardless
          // of the temporary NOTIFY_DEDUPE="0" diagnostic flag in
          // wrangler.jsonc, whose vars this config otherwise inherits.
          NOTIFY_DEDUPE: "1",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // Phase worktrees live under .worktrees/ during the build and carry their
    // own copy of the suite; without this vitest collects them too and reports
    // the same tests several times over.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
