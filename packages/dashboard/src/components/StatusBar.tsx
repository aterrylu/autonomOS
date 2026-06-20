import { useEffect, useMemo, useRef, useState } from "react";
import { plugins } from "../plugins/registry";
import { SettingsPanel } from "../plugins/settings/SettingsStatusBarItem";
import type { StatusBarItem } from "../plugins/types";
import { THEMES, useStore } from "../store";
import {
  getLoadedDashboardBuildId,
  isDashboardStale,
} from "../utils/dashboardFreshness";
import { Codicon } from "./Codicon";

export function StatusBar() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [host, setHost] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    fetch("/api/host")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setHost(d.hostname ?? "unknown");
        // Surface a stale dashboard (deploy-while-open, or a stale-serve) instead
        // of silently running an old bundle. Server reports its served bundle id.
        const loaded = getLoadedDashboardBuildId();
        if (isDashboardStale(loaded, d.dashboard?.build)) {
          console.warn(
            `Dashboard is out of date: this tab loaded ${loaded}, but the server is serving ${d.dashboard.build}. Reload to update.`,
          );
        }
      })
      .catch((err) => {
        console.warn("Failed to fetch hostname:", err);
        setHost("offline");
      });
  }, []);

  const { left, right } = useMemo(() => {
    const items: StatusBarItem[] = [];
    for (const plugin of plugins) {
      if (plugin.statusBarItems) items.push(...plugin.statusBarItems);
    }
    const left = items
      .filter((i) => i.align === "left")
      .sort((a, b) => a.priority - b.priority);
    const right = items
      .filter((i) => i.align === "right")
      .sort((a, b) => a.priority - b.priority);
    return { left, right };
  }, []);

  return (
    <div
      className="relative flex shrink-0 items-center justify-between"
      style={{
        height: 24,
        borderTop: `1px solid ${page.border}`,
        background: page.bg,
        color: page.statusFg,
        fontSize: 12,
        zIndex: 50,
      }}
    >
      <div className="flex items-center gap-3 pl-0 pr-3">
        {/* Settings + hostname badge — flush to left edge */}
        <div className="relative">
          <button
            ref={badgeRef}
            type="button"
            onClick={() => setSettingsOpen(!settingsOpen)}
            className="flex items-center cursor-pointer hover:brightness-110"
            style={{
              background: "#16825d",
              color: "#fff",
              height: 24,
              gap: 6,
              padding: "0 10px 0 8px",
            }}
            title="Settings"
          >
            <Codicon name="gear" size={14} style={{ opacity: 0.85 }} />
            <span>{host || "..."}</span>
          </button>
          {settingsOpen && (
            <SettingsPanel
              onClose={() => setSettingsOpen(false)}
              toggleRef={badgeRef}
            />
          )}
        </div>
        {left.map((item) => {
          const Component = item.component;
          return <Component key={item.id} />;
        })}
      </div>
      <div className="flex items-center gap-3 px-3">
        {right.map((item) => {
          const Component = item.component;
          return <Component key={item.id} />;
        })}
      </div>
    </div>
  );
}
