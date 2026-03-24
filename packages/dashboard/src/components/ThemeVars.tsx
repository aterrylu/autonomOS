import { useEffect } from "react";
import { THEMES, useStore } from "../store";

/**
 * Syncs the active theme to CSS custom properties so shadcn/21st.dev
 * components can use Tailwind classes like bg-card, text-foreground, etc.
 */

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export function ThemeVars() {
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    const page = THEMES[theme].page;
    const root = document.documentElement;

    root.style.setProperty("--background", hexToRgb(page.bg));
    root.style.setProperty("--foreground", hexToRgb(page.fg));
    root.style.setProperty("--card", hexToRgb(page.bg));
    root.style.setProperty("--card-foreground", hexToRgb(page.fg));
    root.style.setProperty("--muted", hexToRgb(page.border));
    root.style.setProperty("--muted-foreground", hexToRgb(page.statusFg));
    root.style.setProperty("--border", hexToRgb(page.border));
    root.style.setProperty("--accent", hexToRgb(page.border));
    root.style.setProperty("--accent-foreground", hexToRgb(page.fg));
  }, [theme]);

  return null;
}
