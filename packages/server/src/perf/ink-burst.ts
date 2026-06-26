// Synthetic "Ink-style" burst generator for terminal performance benchmarking.
//
// Models the output pattern of Claude Code (which renders via Ink) and of a
// noisy build command (`npm install` / `make build`): many SMALL writes per
// logical screen update, heavy SGR color usage, in-place repaints via cursor
// moves, and periodic full-screen redraws. The point is to reproduce the
// FRAGMENTATION that makes the live terminal path emit one WebSocket frame per
// tiny PTY chunk.
//
// Deterministic: given the same options it always produces the same chunk
// sequence (a seeded PRNG, no Date.now / Math.random). This is what lets the
// ablation A/B be trustworthy — the only thing that changes between runs is the
// fix-under-test, never the load.
//
// IMPORTANT (integrity): a synthetic load only proves something if it
// reproduces the real symptom on `main`. The defaults here are tuned to emit a
// realistic burst; if baseline shows no measurable jank, make the generator
// more aggressive (smaller chunks / more repaints) until it does — do NOT trust
// a green number from a load that never stressed the system.

export interface BurstOptions {
  /** Total approximate payload size in bytes. */
  totalBytes: number;
  /** Mean chunk size in bytes — small mimics Ink's many tiny write() calls. */
  meanChunk: number;
  /** Fraction of chunks that are full-screen repaints (cursor-home + redraw). */
  repaintRatio: number;
  /** Terminal width used for line wrapping in repaints. */
  cols: number;
  /** Seed for the deterministic PRNG. */
  seed: number;
}

export const DEFAULT_BURST: BurstOptions = {
  totalBytes: 512 * 1024, // ~500KB — a `npm install`-sized burst
  meanChunk: 48, // Ink emits many sub-100-byte writes
  repaintRatio: 0.15,
  cols: 120,
  seed: 1337,
};

/** Unique end-of-burst marker. The harness polls for this to time "catch-up". */
export const SENTINEL = "[0m__AUTONOMOS_PERF_SENTINEL__\r\n";

// Mulberry32 — tiny deterministic PRNG. No global RNG (would break determinism).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SGR = ["[31m", "[32m", "[33m", "[36m", "[1;35m", "[90m", "[0m"];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Build the full burst as an ordered array of chunks. Each array element is one
 * PTY "chunk" — i.e. what `pty.onData` would fire once with, and (on `main`)
 * exactly one `ws.send()` frame. The COUNT of this array is the headline
 * baseline metric: how many frames `main` would put on the wire.
 */
export function buildBurst(opts: BurstOptions = DEFAULT_BURST): string[] {
  const rand = mulberry32(opts.seed);
  const chunks: string[] = [];
  let emitted = 0;
  let spin = 0;
  let line = 0;

  const pushSplit = (text: string) => {
    // Fragment a logical line into several small chunks, mimicking Ink writing
    // a styled line as many separate write() calls (style, text, reset...).
    let i = 0;
    while (i < text.length) {
      const size = Math.max(
        1,
        Math.round(opts.meanChunk * (0.4 + 1.2 * rand())),
      );
      const piece = text.slice(i, i + size);
      chunks.push(piece);
      emitted += piece.length;
      i += size;
    }
  };

  while (emitted < opts.totalBytes) {
    const isRepaint = rand() < opts.repaintRatio;
    if (isRepaint) {
      // Full in-place repaint: home cursor, redraw a block of styled lines —
      // exactly the pattern that makes a single visual update fan into dozens
      // of frames.
      chunks.push("[H"); // cursor home
      emitted += 3;
      const rows = 6 + Math.floor(rand() * 10);
      for (let r = 0; r < rows; r++) {
        const color = SGR[Math.floor(rand() * SGR.length)];
        const width = 20 + Math.floor(rand() * (opts.cols - 25));
        const body = "─".repeat(width);
        pushSplit(`${color}${SPINNER[spin % SPINNER.length]} ${body}[0m`);
        chunks.push("[K\r\n"); // clear-to-eol + newline
        emitted += 4;
        spin++;
      }
    } else {
      // Scrolling output: a styled log line, fragmented.
      const color = SGR[Math.floor(rand() * SGR.length)];
      const width = 10 + Math.floor(rand() * (opts.cols - 15));
      pushSplit(`${color}[${line}] ${"x".repeat(width)}[0m\r\n`);
      line++;
    }
  }

  chunks.push(SENTINEL);
  return chunks;
}

/** Total byte length of a built burst (for throughput math). */
export function burstBytes(chunks: string[]): number {
  let n = 0;
  for (const c of chunks) n += Buffer.byteLength(c);
  return n;
}
