/**
 * Discord adapter — stub implementation.
 *
 * TODO: Implement with discord.js v14
 * - Connect with GatewayIntentBits: MessageContent, GuildMessages, DirectMessages
 * - Normalize messageCreate events to GatewayMessage
 * - Send typing indicators while CC processes
 * - Chunk replies at 2000 chars
 * - Mention gating in group channels
 */

import { StubAdapter } from "./stub.js";

export class DiscordAdapter extends StubAdapter {
  constructor() {
    super("discord");
  }
}
