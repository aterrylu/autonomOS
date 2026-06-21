import { type ReactNode, useId } from "react";
import { THEMES, useStore } from "../../store";
import {
  type AgentStatus,
  type StatusCategory,
  statusCategory,
} from "./agent-status-icon";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

/**
 * Per-provider agent icon ("Provider + status" style).
 *
 * The provider's official mark is the main glyph; agent status rides in a small
 * corner badge. This is the alternative to the status-only `AgentStatusIcon` —
 * the dashboard chooses between them via the `agentIconStyle` setting.
 *
 * Logos are the official, UNALTERED marks (Claude clay sunburst, OpenAI Codex
 * monochrome, Google Gemini gradient sparkle). Per each vendor's brand policy
 * they are used referentially (to indicate which runtime backs an agent) and
 * are not recolored. See the repo NOTICE / TRADEMARKS section.
 */

// ── Official brand paths (viewBox 0 0 24 24) ─────────────────────────────
const CLAUDE_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";
const CODEX_PATH =
  "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
const GEMINI_PATH =
  "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";

// Claude's mark uses its official brand clay (high-contrast on light + dark).
// Codex is monochrome, so it follows the theme foreground (see ProviderIcon).
const CLAUDE_CLAY = "#d97757";

/** A single-path mark drawn in one flat color (Codex, Claude). Gemini's
 *  multi-gradient mark renders inline since it can't share this shape. */
function MonochromeMark({
  size,
  label,
  color,
  path,
}: {
  size: number;
  label: string;
  color: string;
  path: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
      style={{ display: "block", color }}
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

/** The provider's official mark, sized to `size` px. `provider` is the raw
 *  string from the session/org payload; unknown values fall back to a neutral
 *  glyph so the icon never disappears. */
export function ProviderIcon({
  provider,
  size = 18,
}: {
  provider: string | undefined;
  size?: number;
}) {
  // Unique per-instance gradient ids so multiple Gemini marks don't collide.
  // Strip colons from React's useId() output — they're awkward inside SVG
  // `url(#…)` fragment references.
  const uid = useId().replace(/:/g, "");
  // Codex (monochrome) and the unknown fallback follow the theme so they stay
  // legible on both the dark and light (daylight) themes.
  const page = THEMES[useStore((s) => s.theme)].page;

  if (provider === "gemini-cli") {
    const g0 = `gem0-${uid}`;
    const g1 = `gem1-${uid}`;
    const g2 = `gem2-${uid}`;
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        role="img"
        aria-label="Gemini"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient
            id={g0}
            gradientUnits="userSpaceOnUse"
            x1="7"
            x2="11"
            y1="15.5"
            y2="12"
          >
            <stop stopColor="#08B962" />
            <stop offset="1" stopColor="#08B962" stopOpacity="0" />
          </linearGradient>
          <linearGradient
            id={g1}
            gradientUnits="userSpaceOnUse"
            x1="8"
            x2="11.5"
            y1="5.5"
            y2="11"
          >
            <stop stopColor="#F94543" />
            <stop offset="1" stopColor="#F94543" stopOpacity="0" />
          </linearGradient>
          <linearGradient
            id={g2}
            gradientUnits="userSpaceOnUse"
            x1="3.5"
            x2="17.5"
            y1="13.5"
            y2="12"
          >
            <stop stopColor="#FABC12" />
            <stop offset=".46" stopColor="#FABC12" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={GEMINI_PATH} fill="#3186FF" />
        <path d={GEMINI_PATH} fill={`url(#${g0})`} />
        <path d={GEMINI_PATH} fill={`url(#${g1})`} />
        <path d={GEMINI_PATH} fill={`url(#${g2})`} />
      </svg>
    );
  }

  if (provider === "codex") {
    return (
      <MonochromeMark
        size={size}
        label="Codex"
        color={page.fg}
        path={CODEX_PATH}
      />
    );
  }

  if (provider === "claude-code") {
    return (
      <MonochromeMark
        size={size}
        label="Claude"
        color={CLAUDE_CLAY}
        path={CLAUDE_PATH}
      />
    );
  }

  // Unknown / legacy provider — neutral terminal-ish glyph.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Agent"
      style={{ display: "block", color: page.statusFg }}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M8 9l3 3-3 3M13 15h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Corner status badge ──────────────────────────────────────────────────
//
// Badges separate from the provider glyph behind them via a hairline / disc in
// the theme background color (`page.bg`); the spinner and triangle/dot cutouts
// use the same token so the whole system tracks light + dark themes. The status
// hues (green/amber/gray) are high-contrast on both and stay fixed.

/** Shared scaffolding for the static corner badges (everything except the
 *  syncing spinner, which needs a different wrapper). `px` sizes the badge and
 *  `offset` is the negative overhang in px; both are tuned per-category. */
function CornerSvg({
  px,
  offset,
  label,
  children,
}: {
  px: number;
  offset: number;
  label: string;
  children: ReactNode;
}) {
  return (
    <svg
      className="absolute"
      style={{ right: offset, bottom: offset, display: "block" }}
      width={px}
      height={px}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
    >
      {children}
    </svg>
  );
}

function StatusCorner({
  category,
  size,
  page,
}: {
  category: StatusCategory;
  size: number;
  page: PageTheme;
}) {
  // Badge sizes scale with the host glyph; tuned against an 18px glyph.
  const round = (f: number) => Math.round(size * f);
  const ring = page.bg;

  if (category === "syncing") {
    const px = round(0.68);
    return (
      <span
        className="absolute flex items-center justify-center rounded-full"
        style={{
          right: -3,
          bottom: -3,
          width: px,
          height: px,
          background: ring,
        }}
      >
        <svg
          className="animate-spin"
          width={px - 2}
          height={px - 2}
          viewBox="0 0 16 16"
          role="img"
          aria-label="Working"
          style={{ display: "block" }}
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke={page.fg}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="17 50"
          />
        </svg>
      </span>
    );
  }

  if (category === "warning") {
    return (
      <CornerSvg px={round(0.8)} offset={-4} label="Needs input">
        <path
          d="M8 1.3 L15.2 14.2 L.8 14.2 Z"
          fill="#eab308"
          stroke={ring}
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <rect x="7.15" y="5.6" width="1.7" height="4.4" rx=".85" fill={ring} />
        <circle cx="8" cy="11.8" r=".95" fill={ring} />
      </CornerSvg>
    );
  }

  if (category === "stopped") {
    return (
      <CornerSvg px={round(0.74)} offset={-4} label="Stopped">
        <circle
          cx="8"
          cy="8"
          r="6.2"
          fill={ring}
          stroke="#6b7280"
          strokeWidth="2.2"
        />
        <path
          d="M4 12 L12 4"
          stroke="#6b7280"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </CornerSvg>
    );
  }

  if (category === "unknown") {
    return (
      <CornerSvg px={round(0.55)} offset={-3} label="Unknown">
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill={ring}
          stroke="#6b7280"
          strokeWidth="2"
          strokeDasharray="3 3"
        />
      </CornerSvg>
    );
  }

  // completed (idle / ready) — green dot
  return (
    <CornerSvg px={round(0.55)} offset={-3} label="Idle">
      <circle
        cx="8"
        cy="8"
        r="7"
        fill="#22c55e"
        stroke={ring}
        strokeWidth="1.2"
      />
    </CornerSvg>
  );
}

/**
 * Provider mark + corner status badge. Drop-in alternative to `AgentStatusIcon`
 * for agent rows that carry a provider. Default `size` matches the sidebar
 * (18px glyph; the corner badge overhangs slightly).
 */
export function ProviderAgentIcon({
  provider,
  status,
  size = 18,
}: {
  provider: string | undefined;
  status: AgentStatus;
  size?: number;
}) {
  const category = statusCategory(status);
  const page = THEMES[useStore((s) => s.theme)].page;
  return (
    <span
      className="relative inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <ProviderIcon provider={provider} size={size} />
      <StatusCorner category={category} size={size} page={page} />
    </span>
  );
}
