// Minimal stub — replaced in Phase 7 with the real cron producer / queue consumer.
import type { Env, ScrapeMessage } from "./types";

export default {
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // replaced in Phase 7
  },

  async queue(
    _batch: MessageBatch<ScrapeMessage>,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // replaced in Phase 7
  },
};
