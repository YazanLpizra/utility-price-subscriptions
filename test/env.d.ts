declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
    /**
     * Bindings that are NOT vars in wrangler.jsonc — a var there would share the
     * binding namespace with secrets and overwrite `wrangler secret put` on
     * every deploy. In production these arrive as secrets; in tests they come
     * from vitest.config.ts's miniflare bindings, so they are declared here
     * rather than in the generated worker-configuration.d.ts.
     */
    ALERT_DESTINATION: string;
    NOTIFY_DEDUPE: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_API_BASE?: string;
  }
}

// Vite's `?raw` suffix imports a file as a string. Used by the fixture-backed
// tests (Phase 1's foundation test, Phase 2's parser test) so no `node:fs`
// access is needed inside the workerd pool.
declare module "*?raw" {
  const content: string;
  export default content;
}
