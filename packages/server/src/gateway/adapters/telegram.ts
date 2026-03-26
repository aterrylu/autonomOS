/**
 * Telegram adapter — stub implementation.
 *
 * TODO: Implement with grammY
 * - Long polling mode (catches up on missed messages after restart)
 * - Persist lastUpdateId for offset-based catch-up (borrow from OpenClaw)
 * - Normalize message events to GatewayMessage
 * - Send chat actions while CC processes
 * - Chunk replies at 4096 chars
 */

import { StubAdapter } from "./stub.js";

export class TelegramAdapter extends StubAdapter {
  constructor() {
    super("telegram");
  }
}
