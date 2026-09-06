declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

// Vite's `?raw` suffix imports a file as a string. Used by the fixture-backed
// tests (Phase 1's foundation test, Phase 2's parser test) so no `node:fs`
// access is needed inside the workerd pool.
declare module "*?raw" {
  const content: string;
  export default content;
}
