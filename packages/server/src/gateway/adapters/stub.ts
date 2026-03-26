/**
 * Base stub adapter — shared implementation for platform adapters
 * that haven't been connected to a real SDK yet.
 *
 * Each platform adapter extends this with its own platform name and
 * TODO notes for the real implementation.
 */

import type {
  GatewayMessage,
  GatewayReply,
  Platform,
  PlatformAdapter,
} from "@autonomos/core";

export class StubAdapter implements PlatformAdapter {
  readonly platform: Platform;
  private connected = false;
  protected handler: ((msg: GatewayMessage) => void) | null = null;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async connect(): Promise<void> {
    console.log(`[${this.platform}] stub: connect() — not implemented`);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    console.log(`[${this.platform}] stub: disconnect()`);
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(reply: GatewayReply): Promise<string> {
    console.log(
      `[${this.platform}] stub: send to ${reply.chatId}: ${reply.text.slice(0, 80)}...`,
    );
    return `stub-msg-${Date.now()}`;
  }

  onMessage(handler: (msg: GatewayMessage) => void): void {
    this.handler = handler;
  }
}
