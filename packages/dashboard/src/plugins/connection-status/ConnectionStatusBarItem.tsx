import { useEffect, useState } from "react";
import { THEMES, useStore } from "../../store";

type ServerHealth = "connected" | "disconnected" | "checking";

function useServerHealth(): ServerHealth {
  const [health, setHealth] = useState<ServerHealth>("checking");

  useEffect(() => {
    let mounted = true;

    async function check() {
      try {
        const res = await fetch("/api/host");
        if (mounted) setHealth(res.ok ? "connected" : "disconnected");
      } catch (err) {
        console.debug("Health check failed:", err);
        if (mounted) setHealth("disconnected");
      }
    }

    check();
    const interval = setInterval(check, 15_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return health;
}

function classify(health: ServerHealth): {
  color: string;
  label: string;
  pulse: boolean;
} {
  switch (health) {
    case "connected":
      return { color: "#3fb950", label: "Connected", pulse: false };
    case "checking":
      return { color: "#d29922", label: "Checking...", pulse: true };
    default:
      return { color: "#ea6c73", label: "Disconnected", pulse: false };
  }
}

export function ConnectionStatusBarItem() {
  const health = useServerHealth();
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { color, label, pulse } = classify(health);

  return (
    <span
      className="flex items-center gap-1.5"
      style={{ color: page.statusFg }}
      title={`Server: ${label}`}
    >
      <span
        className="inline-block rounded-full"
        style={{
          width: 7,
          height: 7,
          background: color,
          boxShadow: pulse ? `0 0 4px ${color}` : undefined,
          animation: pulse ? "pulse 1.5s ease-in-out infinite" : undefined,
        }}
      />
      <span>{label}</span>
    </span>
  );
}
