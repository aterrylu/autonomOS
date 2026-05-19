interface WelcomeProps {
  onConnectRemote: () => void;
  onSetupLocal: () => void;
}

export function Welcome({
  onConnectRemote,
  onSetupLocal,
}: WelcomeProps): React.ReactElement {
  return (
    <div className="welcome">
      <h1>Welcome to autonomOS</h1>
      <p className="tagline">
        autonomOS Desktop is a window into your autonomOS Server. Connect to one
        to get started.
      </p>
      <div className="cards">
        <div className="card">
          <h2>Set up local server</h2>
          <p>
            Installs autonomOS Server as a background service on this Mac
            (launchd LaunchAgent). Keeps running when you close this app.
          </p>
          <button type="button" onClick={onSetupLocal}>
            Install
          </button>
        </div>
        <div className="card">
          <h2>Connect to existing server</h2>
          <p>
            Paste the URL and token from a server you&apos;ve already installed
            — local, LAN, or remote.
          </p>
          <button type="button" className="primary" onClick={onConnectRemote}>
            Connect
          </button>
        </div>
      </div>
      <p className="footer">
        Don&apos;t have a server yet? Run on any Mac or Linux box:
        <br />
        <code>curl -fsSL https://autonomos.cloud/install.sh | sh</code>
      </p>
    </div>
  );
}
