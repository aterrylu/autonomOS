import { useEffect, useMemo, useState } from "react";
import { plugins } from "../plugins/registry";
import type { StatusBarItem } from "../plugins/types";
import { THEMES, useStore } from "../store";

export function StatusBar() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [host, setHost] = useState("");

  useEffect(() => {
    fetch("/api/host")
      .then((r) => r.json())
      .then((d) => setHost(d.hostname))
      .catch(() => {});
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
      className="flex shrink-0 items-center justify-between"
      style={{
        height: 24,
        borderTop: `1px solid ${page.border}`,
        background: page.bg,
        color: page.statusFg,
        fontSize: 12,
      }}
    >
      <div className="flex items-center gap-3 px-3">
        <span
          className="flex items-center gap-1.5 -ml-3 px-2.5 font-medium"
          style={{
            background: "#16825d",
            color: "#fff",
            height: 24,
          }}
        >
          {host || "..."}
        </span>
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
