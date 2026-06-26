/** Splash window shown while the Built-in server is starting up. */
export function Splash(): React.ReactElement {
  return (
    <div className="splash">
      <div className="splash-mark">a</div>
      <div className="splash-title">autonomOS</div>
      <div className="splash-spinner" aria-hidden="true">
        <div className="splash-dot" />
        <div className="splash-dot" />
        <div className="splash-dot" />
      </div>
      <div className="splash-status">Starting autonomOS…</div>
    </div>
  );
}
