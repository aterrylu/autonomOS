import { ConnectionWindow } from "./ConnectionWindow.js";
import { WelcomeWindow } from "./WelcomeWindow.js";

/** Each BrowserWindow loads the same dist/renderer/index.html. Which view
 *  renders is determined by the URL hash:
 *    - empty hash → Welcome (no connection assigned to this window yet)
 *    - "#<id>"    → Connection window for that id */
export function App(): React.ReactElement {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.length === 0) return <WelcomeWindow />;
  return <ConnectionWindow connectionId={hash} />;
}
