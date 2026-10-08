/**
 * Make agent-controlled text safe to put inside a bracketed paste: drop every
 * C0 and C1 control character except tab and newline (security audit V7).
 *
 * Used for every bracketed paste autonomOS writes into an agent's PTY whose
 * text another agent can influence: a hand-off (handoffDelivery.ts) and a
 * re-delivered starting prompt (promptDelivery.ts). If that text could end
 * paste mode early, the rest would be typed as raw keystrokes (Shift+Tab, "\x1b[Z", cycles Gemini's
 * approval mode; a CR submits). The previous version stripped the literal
 * terminator "\x1b[201~" in one pass, so a NESTED one ("\x1b[20" +
 * "\x1b[201~" + "1~") was reassembled by the strip itself. Removing the ESC
 * (and C1 CSI, \u009b) characters instead closes that by construction:
 * deleting single characters can't create one, so no output can contain a
 * terminator or any other escape sequence. CR goes too (it would submit).
 */
export function sanitizeForPaste(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
