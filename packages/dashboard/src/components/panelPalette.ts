import type { THEMES } from "../store";
import { isLightBg } from "./recency";

type PageTheme = Pick<
  (typeof THEMES)[keyof typeof THEMES]["page"],
  "bg" | "fg" | "border"
>;

/**
 * Card / input / chip surfaces for the settings-style panels (Presets,
 * Schedules, New Agent), chosen by the page background.
 *
 * These panels used to hardcode dark-only literals (cream title text, a
 * navy card, white-alpha fills), which painted a grey slab with pale text on
 * Daylight. The dark branch keeps those exact literals, so the dark themes
 * render unchanged; the light branch mirrors TemplatesPanel's light palette.
 * `panelColors.test.ts` keeps the dark literals out of panel files.
 */
export function panelPalette(page: PageTheme) {
  return isLightBg(page.bg)
    ? {
        title: page.fg,
        card: "#ffffff",
        cardBorder: page.border,
        input: "rgba(0,0,0,0.03)",
        subtle: "rgba(0,0,0,0.05)",
        faint: "rgba(0,0,0,0.03)",
        faintest: "rgba(0,0,0,0.015)",
        mutedBorder: "rgba(0,0,0,0.08)",
        dotOff: "rgba(0,0,0,0.15)",
        dotOffBorder: "rgba(0,0,0,0.2)",
      }
    : {
        title: "#e6e1cf",
        card: "rgba(28, 36, 51, 0.6)",
        cardBorder: "rgba(255,255,255,0.06)",
        input: "rgba(0,0,0,0.3)",
        subtle: "rgba(255,255,255,0.06)",
        faint: "rgba(255,255,255,0.04)",
        faintest: "rgba(255,255,255,0.02)",
        mutedBorder: "rgba(255,255,255,0.08)",
        dotOff: "rgba(255,255,255,0.2)",
        dotOffBorder: "rgba(255,255,255,0.1)",
      };
}
