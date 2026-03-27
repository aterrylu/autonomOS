import { AnimatePresence, motion } from "framer-motion";

/**
 * Agent status types derived from Claude Code hook events.
 */
export type AgentStatus =
  | "unknown"
  | "ready"
  | "working"
  | "tool_running"
  | "idle"
  | "needs_input"
  | "error"
  | "compacting"
  | "orchestrating"
  | "stopped";

type StatusCategory =
  | "completed"
  | "warning"
  | "syncing"
  | "stopped"
  | "unknown";

interface AgentStatusIconProps {
  status: AgentStatus;
  size?: number;
}

/** Pre-computed spinner dash positions (8 evenly-spaced dashes around center) */
const SPINNER_DASHES = Array.from({ length: 8 }, (_, i) => {
  const radian = ((i * 45 - 90) * Math.PI) / 180;
  const r = 6;
  const dl = 1.8;
  return {
    x1: 8 + (r - dl / 2) * Math.cos(radian),
    y1: 8 + (r - dl / 2) * Math.sin(radian),
    x2: 8 + (r + dl / 2) * Math.cos(radian),
    y2: 8 + (r + dl / 2) * Math.sin(radian),
  };
});

/** Collapse statuses into visual categories for icon selection and AnimatePresence keying */
function statusCategory(status: AgentStatus): StatusCategory {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "needs_input":
    case "error":
      return "warning";
    case "working":
    case "tool_running":
    case "compacting":
    case "orchestrating":
      return "syncing";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

/**
 * Animated status icon for agent sessions.
 *
 * - Completed/idle: green circle with checkmark
 * - Needs input/error: yellow triangle with exclamation
 * - Working/syncing: spinning dash loader (pure CSS animation — no React re-renders)
 * - Stopped: gray circle with dash
 */
export function AgentStatusIcon({ status, size = 16 }: AgentStatusIconProps) {
  const category = statusCategory(status);

  return (
    <div
      className="flex items-center justify-center overflow-hidden"
      style={{ width: size, height: size }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={category}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.8, opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
        >
          <StatusSvg category={category} size={size} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * CSS keyframes for the spinner — injected once into the document head.
 * Cycles through 8 dashes by animating opacity in discrete steps.
 * Runs entirely on the compositor thread.
 */
const SPINNER_STYLE_ID = "agent-spinner-keyframes";
if (
  typeof document !== "undefined" &&
  !document.getElementById(SPINNER_STYLE_ID)
) {
  const style = document.createElement("style");
  style.id = SPINNER_STYLE_ID;
  style.textContent = `
@keyframes dash-spin {
  0%, 100%  { opacity: 1 }
  12.5%     { opacity: 0 }
}`;
  document.head.appendChild(style);
}

function StatusSvg({
  category,
  size,
}: {
  category: StatusCategory;
  size: number;
}) {
  switch (category) {
    case "completed":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          role="img"
          aria-label="Idle"
          className="drop-shadow-sm"
        >
          <circle cx="8" cy="8" r="8" fill="#22c55e" />
          <path
            d="M5 8l2.5 2.5 3.5-4"
            stroke="white"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "warning":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          role="img"
          aria-label="Needs input"
        >
          <path
            d="M8 1.5L14.5 13H1.5L8 1.5Z"
            fill="#eab308"
            stroke="#eab308"
            strokeWidth="1"
            strokeLinejoin="round"
          />
          <path
            d="M8 6v3M8 11h0"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "syncing":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          role="img"
          aria-label="Working"
        >
          {SPINNER_DASHES.map((dash, index) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed set of 8 dashes
              key={index}
              x1={dash.x1}
              y1={dash.y1}
              x2={dash.x2}
              y2={dash.y2}
              stroke="#ffffff"
              strokeWidth="2"
              strokeLinecap="round"
              style={{
                animation: "dash-spin 800ms steps(1, end) infinite",
                animationDelay: `${-index * 100}ms`,
                opacity: 0.3,
              }}
            />
          ))}
        </svg>
      );
    case "stopped":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          role="img"
          aria-label="Stopped"
        >
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="none"
            stroke="#6b7280"
            strokeWidth="1.5"
          />
          <line
            x1="5"
            y1="8"
            x2="11"
            y2="8"
            stroke="#6b7280"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          role="img"
          aria-label="Unknown"
        >
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="none"
            stroke="#4b5563"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />
        </svg>
      );
  }
}

/** Human-readable label for a status */
export function agentStatusLabel(
  status: AgentStatus,
  currentTool?: string,
): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "working":
      return "Working";
    case "tool_running":
      return currentTool ? `Running ${currentTool}` : "Running tool";
    case "idle":
      return "Idle";
    case "needs_input":
      return "Needs input";
    case "error":
      return "Error";
    case "compacting":
      return "Compacting";
    case "orchestrating":
      return "Orchestrating";
    case "stopped":
      return "Stopped";
    default:
      return "";
  }
}
