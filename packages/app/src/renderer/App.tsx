import { ConnectionWindow } from "./ConnectionWindow.js";
import { Splash } from "./Splash.js";
import { WelcomeWindow } from "./WelcomeWindow.js";

/** Hash routing:
 *    #splash   → splash window during server startup
 *    #<id>     → ConnectionWindow for that id ("local" = "This Mac")
 *    (empty)   → WelcomeWindow (add-remote-connection flow) */
export function App(): React.ReactElement {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "splash") return <Splash />;
  if (hash.length === 0) return <WelcomeWindow />;
  return <ConnectionWindow connectionId={hash} />;
}
