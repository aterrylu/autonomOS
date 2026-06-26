interface TitleBarProps {
  /** Optional center label (e.g. connection name when connected). */
  label?: string;
  /** Right-side content (buttons, status, etc.). */
  children?: React.ReactNode;
}

/** Custom title bar that reserves space for the macOS traffic-light buttons
 *  (which `titleBarStyle: "hiddenInset"` leaves overlaying the content).
 *
 *  Layout:
 *    [traffic-light reserve (80px)] [label center] [actions right]
 *
 *  The whole bar is draggable (`-webkit-app-region: drag`); any interactive
 *  children must opt out with `-webkit-app-region: no-drag` on themselves. */
export function TitleBar({
  label,
  children,
}: TitleBarProps): React.ReactElement {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: window-chrome zoom; mouse-only by platform convention
    <div
      className="titlebar"
      onDoubleClick={(e) => {
        // Native macOS title bars zoom on double-click — but not when the
        // double-click landed on an interactive child (mirrors how those
        // children opt out of dragging with no-drag). Selector mirrors
        // INTERACTIVE_SELECTOR in preload/webview.ts (separate CJS build,
        // can't share an import) — keep the two in sync.
        if (
          e.target instanceof Element &&
          e.target.closest("button, a, input, select, textarea")
        ) {
          return;
        }
        window.autonomos.windows.zoom();
      }}
    >
      <div className="titlebar-reserve" />
      <div className="titlebar-label">{label ?? ""}</div>
      <div className="titlebar-actions">{children}</div>
    </div>
  );
}
