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
    <div className="titlebar">
      <div className="titlebar-reserve" />
      <div className="titlebar-label">{label ?? ""}</div>
      <div className="titlebar-actions">{children}</div>
    </div>
  );
}
