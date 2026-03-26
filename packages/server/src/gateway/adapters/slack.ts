/**
 * Slack adapter — stub implementation.
 *
 * TODO: Implement with @slack/bolt (Socket Mode — no public URL needed)
 * - Socket Mode requires bot token + app-level token
 * - Normalize message events to GatewayMessage
 * - Chunk replies at 40000 chars (Slack's limit)
 * - Typing indicators via chat.meMessage or similar
 */

import { StubAdapter } from "./stub.js";

export class SlackAdapter extends StubAdapter {
  constructor() {
    super("slack");
  }
}
