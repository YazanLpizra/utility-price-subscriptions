import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
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
