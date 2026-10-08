// New-device lock pill (ADR-148).
//
// The alert bar under the header is the owner's main notice (Terry's mockup
// B1). This pill appears only after the owner HIDES that bar, so a hidden lock
// still has a visible reminder; clicking it brings the bar back. It renders
// nothing otherwise (also keeps the README hero unaffected). Styled like the
// update badge's amber "armed" pill: no new visual language.

import { THEMES, useStore } from "../../store";
import { accentsFor } from "../update-badge/UpdateDialog";
import { pillVisible, useLockStore } from "./lockState";
import { LockIcon } from "./NewDeviceLockAlert";

export function NewDeviceLockStatusBarItem() {
  const visible = useLockStore(pillVisible);
  const reopen = useLockStore((s) => s.reopen);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { amber: AMBER } = accentsFor(page.bg);

  if (!visible) return null;

  return (
    <span
      className="flex items-center whitespace-nowrap rounded-full"
      style={{
        color: AMBER,
        boxShadow: `inset 0 0 0 1px ${AMBER}66`,
        background: `${AMBER}14`,
        height: 20,
      }}
      data-testid="new-device-lock"
    >
      <button
        type="button"
        title="Show the lockout alert"
        onClick={() => reopen()}
        className="flex h-5 cursor-pointer items-center gap-1.5 px-2 hover:brightness-125"
        style={{ background: "none", border: "none", color: AMBER }}
      >
        <LockIcon />
        <span>New devices locked out</span>
      </button>
    </span>
  );
}
