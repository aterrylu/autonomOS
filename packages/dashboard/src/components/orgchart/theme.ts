import type { THEMES } from "../../store";
import { isLightBg } from "../recency";
import {
  STATUS_COLORS_DARK,
  STATUS_COLORS_LIGHT,
  UNREAD_COLOR,
} from "../statusLabelStyle";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

/**
 * Every color the org chart paints, derived from the active theme.
 *
 * The chart has NO literal colors of its own outside this function: surfaces
 * come from the page tokens (`THEMES[theme].page`) plus a light/dark choice made
 * by `isLightBg` — the same classifier recency and status labels use — and every
 * status color is the sidebar's own `statusLabelStyle` palette (ADR-090). The old
 * card hardcoded `rgba(28,36,51)` and white connectors, which is why Daylight
 * rendered dark tiles with invisible lines.
 */
export interface OrgChartTokens {
  isLight: boolean;
  bg: string;
  fg: string;
  muted: string;
  card: string;
  cardBorder: string;
  cardShadow: string;
  /** Ghost (exited) card fill — reads as "not here" without vanishing. */
  ghostCard: string;
  edge: string;
  chip: string;
  /** Unread-count red — the sidebar's literal, shared so the two can't drift. */
  unread: string;
  status: typeof STATUS_COLORS_DARK | typeof STATUS_COLORS_LIGHT;
  /** Soft ring/glow colors for the working + needs-input card animations. */
  activeRing: string;
  activeGlow: string;
  attentionRing: string;
  attentionGlow: string;
}

export function orgChartTokens(page: PageTheme): OrgChartTokens {
  const isLight = isLightBg(page.bg);
  const status = isLight ? STATUS_COLORS_LIGHT : STATUS_COLORS_DARK;
  return {
    isLight,
    bg: page.bg,
    fg: page.fg,
    muted: page.statusFg,
    card: isLight ? "#ffffff" : "rgba(255,255,255,0.035)",
    cardBorder: isLight ? page.border : "rgba(255,255,255,0.09)",
    cardShadow: isLight
      ? "0 1px 3px rgba(20,30,40,0.08), 0 4px 14px rgba(20,30,40,0.06)"
      : "0 2px 10px rgba(0,0,0,0.45)",
    ghostCard: isLight ? "rgba(0,0,0,0.015)" : "rgba(255,255,255,0.012)",
    edge: isLight ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.2)",
    chip: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)",
    unread: UNREAD_COLOR,
    status,
    // 8-digit hex alpha on the palette colors: ~35% ring, ~28% glow.
    activeRing: `${status.active}59`,
    activeGlow: `${status.active}47`,
    attentionRing: `${status.needsInput}59`,
    attentionGlow: `${status.needsInput}40`,
  };
}
