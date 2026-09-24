import { useCallback, useEffect, useRef, useState } from "react";
import { agentsApi } from "../../api/agents";
import { agentsSocket, type RoutedMessage } from "../../api/agentsSocket";
import { ProviderAgentIcon } from "../ui/provider-icon";
import { CARD_H, CARD_W, elbowPath, type OrgLayout } from "./layout";
import type { OrgChartTokens } from "./theme";

/**
 * Message flow — agent-to-agent traffic drawn on the chart (the "fun moment").
 *
 * An accepted message (`message.routed`) sends a small envelope along the
 * manager edge (or a dotted arc across teams); on arrival the recipient card
 * bumps and a speech bubble unfurls with the sender and a one-line preview.
 *
 * Guardrails (each one is a product rule, not a nicety):
 *  - TEXT ONLY. Previews arrive sanitized and capped by the server and are
 *    rendered as React text children, never HTML.
 *  - NO PILE-UPS. One bubble per recipient: a burst coalesces into "+N" with
 *    the NEWEST line (ordered by arrival sequence, not landing time). At most
 *    MAX_IN_FLIGHT envelopes travel at once; the rest land without traveling.
 *  - MOTION IS OPTIONAL. "Quiet" and prefers-reduced-motion show bubbles with
 *    no travel and no bump; "Off" shows nothing.
 *  - FULL TEXT ON DEMAND. Hovering a bubble reads the recipient's message log
 *    (`GET /api/agents/:id/messages`); full text is never broadcast.
 */

export type MessageMode = "animated" | "quiet" | "off";

const MAX_IN_FLIGHT = 3;
const TRAVEL_MS = 1100;
const BUBBLE_MS = 4200;
/** Matches the `org-edge-warm` CSS animation; the path is dropped after it. */
const WARM_MS = 6000;
const BUMP_MS = 380;

interface Packet {
  key: number;
  d: string;
  reverse: boolean;
  arc: boolean;
  msg: RoutedMessage;
  anchor: string;
  seq: number;
}

interface Bubble {
  anchor: string;
  lastId: string;
  /** The newest message's real recipient — may differ from `anchor` when the
   *  recipient is folded away; its log is where the full text lives. */
  lastTo: string;
  fromName: string;
  fromProvider?: string;
  preview: string;
  count: number;
  seq: number;
  fading: boolean;
}

export interface MessageLayerProps {
  layout: OrgLayout;
  /** Manager id of each DRAWN node (to pick the edge a packet travels). */
  managerOf: (id: string) => string | undefined;
  /** The drawn card that stands for an agent: itself, or its nearest visible
   *  ancestor when folded away. Undefined when not on the chart at all. */
  anchorOf: (id: string) => string | undefined;
  providerOf: (id: string) => string | undefined;
  nameOf: (id: string) => string | undefined;
  mode: MessageMode;
  tokens: OrgChartTokens;
  onSelect: (id: string) => void;
}

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === "function" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** One traveling envelope. Animates imperatively (refs) — no per-frame
 *  React renders — and reports when it lands. */
function Envelope({
  packet,
  tokens,
  onLand,
}: {
  packet: Packet;
  tokens: OrgChartTokens;
  onLand: (p: Packet) => void;
}) {
  const pathRef = useRef<SVGPathElement>(null);
  const gRef = useRef<SVGGElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per packet (keyed); onLand is read once at the end
  useEffect(() => {
    const path = pathRef.current;
    const g = gRef.current;
    if (!path || !g) return;
    const len = path.getTotalLength?.() ?? 0;
    const t0 = performance.now();
    let raf = 0;
    let landed = false;
    const finish = () => {
      if (landed) return;
      landed = true;
      cancelAnimationFrame(raf);
      clearTimeout(backstop);
      onLand(packet);
    };
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / TRAVEL_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const at = path.getPointAtLength?.((packet.reverse ? 1 - e : e) * len);
      if (at) g.setAttribute("transform", `translate(${at.x},${at.y})`);
      if (k < 1) raf = requestAnimationFrame(step);
      else finish();
    };
    raf = requestAnimationFrame(step);
    // Browsers pause requestAnimationFrame in background tabs. Without this
    // backstop an envelope sent while you're away would hang mid-edge — never
    // landing, and holding an in-flight slot. Measured live: that's exactly
    // what happened in an occluded tab. A timer always lands it.
    const backstop = setTimeout(finish, TRAVEL_MS + 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(backstop);
    };
  }, [packet.key]);
  const c = tokens.status.active;
  return (
    <>
      <path
        ref={pathRef}
        d={packet.d}
        fill="none"
        stroke={packet.arc ? c : "none"}
        strokeWidth={1.4}
        strokeDasharray={packet.arc ? "3 5" : undefined}
        opacity={packet.arc ? 0.8 : 0}
      />
      <g ref={gRef} data-org-envelope>
        <rect
          x={-7}
          y={-5}
          width={14}
          height={10}
          rx={2}
          fill={tokens.bg}
          stroke={c}
          strokeWidth={1.4}
        />
        <polyline
          points="-6,-4 0,1 6,-4"
          fill="none"
          stroke={c}
          strokeWidth={1.4}
        />
      </g>
    </>
  );
}

export function MessageLayer({
  layout,
  managerOf,
  anchorOf,
  providerOf,
  nameOf,
  mode,
  tokens,
  onSelect,
}: MessageLayerProps) {
  const reduced = usePrefersReducedMotion();
  const [packets, setPackets] = useState<Packet[]>([]);
  const packetsRef = useRef<Packet[]>([]);
  packetsRef.current = packets;
  const [bubbles, setBubbles] = useState<Map<string, Bubble>>(new Map());
  const [warm, setWarm] = useState<Map<string, number>>(new Map());
  // Keyed by message id: if a newer message replaces the bubble's line while
  // it's hovered, the old full text must not render under the new header.
  const [open, setOpen] = useState<{
    anchor: string;
    id: string;
    text: string;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const seq = useRef(0);
  const keyRef = useRef(0);
  const inFlight = useRef(0);
  const fadeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const warmTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const hovering = useRef<string | null>(null);

  // Latest render inputs, read from socket callbacks without re-subscribing.
  const live = useRef({
    layout,
    managerOf,
    anchorOf,
    providerOf,
    mode,
    reduced,
  });
  live.current = { layout, managerOf, anchorOf, providerOf, mode, reduced };

  const scheduleFade = useCallback((anchor: string, ms = BUBBLE_MS) => {
    const timers = fadeTimers.current;
    clearTimeout(timers.get(anchor));
    timers.set(
      anchor,
      setTimeout(() => {
        if (hovering.current === anchor) return;
        setBubbles((prev) => {
          const b = prev.get(anchor);
          if (!b) return prev;
          const next = new Map(prev);
          next.set(anchor, { ...b, fading: true });
          return next;
        });
        timers.set(
          anchor,
          setTimeout(() => {
            setBubbles((prev) => {
              const next = new Map(prev);
              next.delete(anchor);
              return next;
            });
            if (hovering.current === anchor) hovering.current = null;
          }, 500),
        );
      }, ms),
    );
  }, []);

  const land = useCallback(
    (msg: RoutedMessage, anchor: string, order: number) => {
      const { reduced: rm, mode: m, providerOf: prov } = live.current;
      if (m === "animated" && !rm) {
        // Scoped to THIS chart's stage (there may be more than one pane).
        const card = svgRef.current?.parentElement?.querySelector<HTMLElement>(
          `[data-org-card="${CSS.escape(anchor)}"]`,
        );
        if (card) {
          card.classList.remove("org-bump");
          void card.offsetWidth; // restart the animation
          card.classList.add("org-bump");
          setTimeout(() => card.classList.remove("org-bump"), BUMP_MS);
        }
      }
      setBubbles((prev) => {
        const next = new Map(prev);
        const b = prev.get(anchor);
        const count = (b?.count ?? 0) + 1;
        // Coalesce: the count always grows, but only a NEWER message (by
        // arrival order) may replace the line — an instant landing must not
        // overwrite a later message with an earlier one, or vice versa.
        next.set(
          anchor,
          b && order < b.seq
            ? { ...b, count, fading: false }
            : {
                anchor,
                count,
                fading: false,
                seq: order,
                lastId: msg.id,
                lastTo: msg.to,
                fromName: msg.fromName,
                fromProvider: msg.from ? prov(msg.from) : undefined,
                preview: msg.preview,
              },
        );
        return next;
      });
      scheduleFade(anchor);
    },
    [scheduleFade],
  );

  useEffect(() => {
    return agentsSocket.onMessageRouted((msg) => {
      const {
        layout: L,
        managerOf: mgr,
        anchorOf: anc,
        mode: m,
        reduced: rm,
      } = live.current;
      if (m === "off") return;
      const anchor = anc(msg.to);
      if (!anchor) return;
      const order = ++seq.current;
      const fromAnchor = msg.from ? anc(msg.from) : undefined;
      const a = fromAnchor ? L.pos.get(fromAnchor) : undefined;
      const b = L.pos.get(anchor);
      // Land without traveling: quiet/reduced, too many already flying, the
      // sender isn't drawn (a schedule, or hidden), or it's to itself.
      if (
        m !== "animated" ||
        rm ||
        // Nobody's watching: don't animate into a hidden tab.
        document.visibilityState === "hidden" ||
        inFlight.current >= MAX_IN_FLIGHT ||
        !a ||
        !b ||
        fromAnchor === anchor
      ) {
        land(msg, anchor, order);
        return;
      }
      let d: string;
      let reverse = false;
      let arc = false;
      if (fromAnchor && mgr(anchor) === fromAnchor) d = elbowPath(a, b);
      else if (fromAnchor && mgr(fromAnchor) === anchor) {
        d = elbowPath(b, a);
        reverse = true;
      } else {
        const x1 = a.x + CARD_W / 2;
        const x2 = b.x + CARD_W / 2;
        const cy = Math.min(a.y, b.y) - 46;
        d = `M${x1},${a.y}Q${(x1 + x2) / 2},${cy} ${x2},${b.y}`;
        arc = true;
      }
      inFlight.current += 1;
      setPackets((p) => [
        ...p,
        { key: ++keyRef.current, d, reverse, arc, msg, anchor, seq: order },
      ]);
    });
  }, [land]);

  const onLand = useCallback(
    (p: Packet) => {
      inFlight.current = Math.max(0, inFlight.current - 1);
      setPackets((all) => all.filter((x) => x.key !== p.key));
      const edge = p.reverse
        ? `${p.anchor}>${live.current.anchorOf(p.msg.from ?? "")}`
        : `${live.current.anchorOf(p.msg.from ?? "")}>${p.anchor}`;
      if (!p.arc) {
        setWarm((w) => new Map(w).set(edge, Date.now()));
        // Drop the path once its glow has faded, so a long-lived chart doesn't
        // carry dead paths (or ones for edges a re-layout removed). A re-warm
        // restarts the clock.
        const timers = warmTimers.current;
        clearTimeout(timers.get(edge));
        timers.set(
          edge,
          setTimeout(() => {
            timers.delete(edge);
            setWarm((w) => {
              if (!w.has(edge)) return w;
              const next = new Map(w);
              next.delete(edge);
              return next;
            });
          }, WARM_MS),
        );
      }
      land(p.msg, p.anchor, p.seq);
    },
    [land],
  );

  // Modes that forbid motion drop anything still traveling (it lands at once).
  useEffect(() => {
    if (mode === "animated" && !reduced) return;
    const flying = packetsRef.current;
    if (flying.length) {
      setPackets([]);
      inFlight.current = 0;
      if (mode !== "off") for (const p of flying) land(p.msg, p.anchor, p.seq);
    }
    if (mode === "off") setBubbles(new Map());
  }, [mode, reduced, land]);

  useEffect(
    () => () => {
      for (const t of fadeTimers.current.values()) clearTimeout(t);
      for (const t of warmTimers.current.values()) clearTimeout(t);
    },
    [],
  );

  const showFull = async (b: Bubble) => {
    hovering.current = b.anchor;
    clearTimeout(fadeTimers.current.get(b.anchor));
    setOpen({ anchor: b.anchor, id: b.lastId, text: b.preview });
    try {
      const stats = await agentsApi.messages(b.lastTo, { limit: 20 });
      const m = stats.recent.find((x) => x.id === b.lastId);
      if (m && hovering.current === b.anchor)
        // Only fills in the message it was fetched for; if the line changed
        // meanwhile, the id check at render time hides it.
        setOpen((o) =>
          o && o.anchor === b.anchor && o.id === b.lastId
            ? { ...o, text: m.text }
            : o,
        );
    } catch {
      // Keep the preview; the full text is a nicety.
    }
  };
  const hideFull = (b: Bubble) => {
    if (hovering.current === b.anchor) hovering.current = null;
    setOpen((o) => (o?.anchor === b.anchor ? null : o));
    scheduleFade(b.anchor, 1800);
  };

  return (
    <>
      <svg
        ref={svgRef}
        aria-hidden="true"
        data-org-message-layer
        className="pointer-events-none absolute inset-0 overflow-visible"
        width={layout.width}
        height={layout.height}
        style={{ zIndex: 3 }}
      >
        {[...warm.entries()].map(([edge, at]) => {
          const [from, to] = edge.split(">");
          const a = layout.pos.get(from);
          const b = layout.pos.get(to);
          if (!a || !b) return null;
          return (
            <path
              key={`${edge}-${at}`}
              d={elbowPath(a, b)}
              fill="none"
              stroke={tokens.status.active}
              strokeWidth={2}
              className="org-edge-warm"
            />
          );
        })}
        {packets.map((p) => (
          <Envelope key={p.key} packet={p} tokens={tokens} onLand={onLand} />
        ))}
      </svg>
      {[...bubbles.values()].map((b) => {
        const at = layout.pos.get(b.anchor);
        if (!at) return null;
        const below = at.y < 72;
        const expanded = open?.anchor === b.anchor && open.id === b.lastId;
        return (
          <button
            key={b.anchor}
            type="button"
            data-org-bubble={b.anchor}
            aria-label={`Message to ${nameOf(b.anchor) ?? "agent"} from ${b.fromName}${b.count > 1 ? ` and ${b.count - 1} more` : ""}: ${b.preview}. Opens details.`}
            className={`org-bubble absolute flex max-w-[240px] cursor-pointer flex-col gap-0.5 rounded-[10px] px-2.5 py-1.5 text-left text-[11.5px] focus-visible:outline-2 ${below ? "org-bubble-below" : ""}${b.fading ? " org-bubble-fade" : ""}`}
            style={{
              left: at.x + 6,
              top: below ? at.y + CARD_H + 10 : at.y - 58,
              zIndex: 4,
              background: tokens.bg,
              color: tokens.fg,
              border: `1px solid ${tokens.status.active}`,
              outlineColor: tokens.status.active,
              ["--org-bubble-bg" as string]: tokens.bg,
              ["--org-bubble-border" as string]: tokens.status.active,
            }}
            onMouseEnter={() => void showFull(b)}
            onFocus={() => void showFull(b)}
            onMouseLeave={() => hideFull(b)}
            onBlur={() => hideFull(b)}
            onClick={() => onSelect(b.anchor)}
          >
            <span
              className="flex items-center gap-1.5 text-[10.5px]"
              style={{ color: tokens.muted }}
            >
              {b.fromProvider && (
                <ProviderAgentIcon
                  provider={b.fromProvider}
                  status="idle"
                  size={12}
                />
              )}
              <span>{b.fromName}</span>
              {b.count > 1 && (
                <span
                  data-org-bubble-count
                  className="ml-auto font-bold tabular-nums"
                  style={{ color: tokens.status.active }}
                >
                  +{b.count - 1}
                </span>
              )}
            </span>
            <span
              data-org-bubble-text
              className={
                expanded
                  ? "max-h-[9em] overflow-auto whitespace-normal"
                  : "truncate"
              }
            >
              {expanded ? open.text : b.preview}
            </span>
          </button>
        );
      })}
    </>
  );
}
