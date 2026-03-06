# VSCode's Electron Architecture: Deep Dive for autonomOS

**Date**: 2026-03-06
**Purpose**: Inform autonomOS desktop shell decision (Electron vs Tauri vs web-only)
**Status**: Complete

---

## Table of Contents

1. [Electron Architecture in VSCode](#1-electron-architecture-in-vscode)
2. [Terminal Integration](#2-terminal-integration-critical-for-autonomos)
3. [Webview Panels](#3-webview-panels)
4. [Extension Host](#4-extension-host)
5. [Performance and Size](#5-performance-and-size)
6. [Build and Distribution](#6-build-and-distribution)
7. [Forks and Derivatives](#7-forks-and-derivatives)
8. [Tauri as an Alternative](#8-tauri-as-an-alternative)
9. [Key Takeaways for autonomOS](#9-key-takeaways-for-autonomos)

---

## 1. Electron Architecture in VSCode

### Process Model

VSCode runs as a collection of isolated processes that communicate via IPC. A typical VSCode instance spawns **4+ core processes**, with additional processes for each terminal, extension, and language server:

| Process | Runtime | Role |
|---------|---------|------|
| **Main Process** | Node.js | App lifecycle, window management, native OS interactions, menu bar |
| **Renderer Process** | Chromium (sandboxed) | Workbench UI -- HTML/CSS/TypeScript, Monaco editor |
| **Extension Host** | Node.js (utility process) | Runs all extensions in isolation, one per window |
| **Shared/PTY Host** | Node.js | File watching, pseudo-terminal management for integrated terminal |
| **Language Server(s)** | Varies | LSP-based language features (one per language) |
| **Debug Adapter(s)** | Varies | DAP-based debugging (spawned on demand) |

A window with a few extensions, a terminal, and a language server easily has **8-15 processes**. Users with many extensions or remote development have reported 80-100+ processes.

### Layered Architecture

VSCode's codebase enforces strict **target environment boundaries** via static analysis tooling:

- **`browser`**: Pure web code -- no Node.js, no Electron APIs. Runs in VS Code for Web.
- **`electron-sandbox`**: Sandboxed renderer -- Chromium APIs only, no Node.js. The workbench runs here.
- **`electron-main`**: Full Node.js access. Window management, file system, process spawning.

Static analysis prevents code in the `electron-sandbox` layer from importing Node.js modules. This is enforced at build time, not just by convention.

### Sandbox Migration (2020-2023)

VSCode completed a multi-year migration to Electron's process sandboxing:

**Before sandboxing:**
- Renderer had direct Node.js access
- Child processes forked directly from renderer
- IPC via Node.js sockets

**After sandboxing:**
- Renderer runs in Chromium sandbox (no Node.js)
- All privileged operations delegated to main process or utility processes
- IPC via Electron's `ipcRenderer`/`ipcMain` and **MessagePort** (web standard)
- Custom `VSBuffer` class replaces Node.js `Buffer` (falls back to `Uint8Array`)
- Custom `vscode-file://` protocol replaces insecure `file://` URLs

### IPC Mechanisms

Communication flows through multiple channels:

1. **Electron IPC** (`ipcRenderer`/`ipcMain`): Renderer-to-main communication, goes through main process
2. **MessagePort** (web standard): Direct process-to-process communication, bypasses main process
   - Used for Extension Host <-> Renderer communication
   - Used for Shared Process <-> Renderer communication
   - Setup flow: Shared process creates port pair -> sends one end to main -> main forwards to renderer
3. **JSON-RPC**: Extension Host <-> Renderer uses RPC with proxy objects on both sides

```
Renderer (sandbox)
    |
    |-- Electron IPC --> Main Process (Node.js)
    |                        |
    |-- MessagePort -------> Extension Host (utility process, Node.js)
    |                        |
    |-- MessagePort -------> Shared Process (Node.js)
    |                             |
    |                             +--> PTY Host (terminal management)
    |                             +--> File Watcher
```

### Preload Scripts

Since the renderer is sandboxed, a **preload script** runs before the main renderer script. It has access to Electron's IPC and exposes a safe API surface via the **context bridge**:

```typescript
// preload.ts (simplified concept)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vscode', {
  ipcRenderer: {
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, listener) => ipcRenderer.on(channel, listener),
  }
});
```

The renderer's main script then uses these exposed APIs -- it never has direct Node.js access.

**Sources:**
- [Migrating VS Code to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [VS Code Architecture Overview (SkyWork)](https://skywork.ai/skypage/en/VS-Code-Architecture-Overview/1977611814760935424)
- [VS Code Under The Hood (The Developer Space)](https://thedeveloperspace.com/vs-code-architecture-guide/)

---

## 2. Terminal Integration (Critical for autonomOS)

This is the most relevant section for autonomOS, since our primary use case is managing Claude Code sessions, which are terminal-based.

### Architecture: xterm.js + node-pty

VSCode's integrated terminal uses a **split architecture**:

| Component | Where it runs | What it does |
|-----------|---------------|--------------|
| **xterm.js** | Renderer process (Chromium) | Terminal UI rendering, input handling, escape sequence parsing |
| **node-pty** | PTY Host process (Node.js) | Spawns and manages pseudo-terminal processes (bash, zsh, etc.) |
| **IPC layer** | MessagePort / Electron IPC | Shuttles data between xterm.js and node-pty |

### Data Flow

```
User types in terminal
    |
    v
xterm.js (renderer) -- captures keystroke
    |
    | IPC (MessagePort)
    v
PTY Host process
    |
    | node-pty writes to PTY fd
    v
Shell process (bash/zsh/fish)
    |
    | Shell produces output
    v
node-pty reads from PTY fd
    |
    | IPC (MessagePort)
    v
xterm.js (renderer) -- renders output
```

### node-pty Details

[node-pty](https://github.com/microsoft/node-pty) is a Microsoft-maintained library that forks pseudo-terminals in Node.js:

- **Platform support**: Linux (forkpty), macOS (forkpty), Windows (ConPTY API on Windows 1809+)
- **API**: `spawn(shell, args, options)` returns a terminal object with `write()`, `onData`, `resize()`, `kill()`
- **Native module**: Written in C++ with N-API bindings -- requires compilation for each platform/Electron version
- **Used by**: VSCode, Hyper, Theia, and many other terminal emulators

### Why the PTY Host Is a Separate Process

The terminal PTY management runs in a dedicated **PTY Host** process (child of the Shared Process), not in the main or renderer process. This provides:

1. **Crash isolation**: A misbehaving shell or native module crash won't take down the editor
2. **Performance isolation**: Heavy terminal output (e.g., `cat large-file.txt`) doesn't block the UI
3. **Security**: PTY operations don't need renderer-level access
4. **Multiple instances**: Each terminal tab maps to a separate PTY, all managed by the same host

### Performance Characteristics

- xterm.js uses **WebGL rendering** (via `@xterm/addon-webgl`) for GPU-accelerated terminal rendering
- Data throughput is limited by IPC bandwidth between PTY Host and renderer
- For most interactive use (including Claude Code), this is more than sufficient
- Extreme throughput scenarios (e.g., catting a multi-GB file) can cause buffering

### Multiple Terminal Instances

Each terminal instance gets its own:
- node-pty `IPty` object in the PTY Host
- xterm.js `Terminal` instance in the renderer
- Bidirectional IPC channel

The PTY Host manages a pool of these, creating/destroying them as the user opens/closes terminals.

### What This Means for autonomOS

To embed Claude Code sessions, we need exactly this pattern:
1. A PTY manager (node-pty or Rust equivalent) to spawn `claude` processes
2. A terminal renderer (xterm.js) in the UI
3. IPC to connect them

This is well-trodden ground. The question is whether we use Electron (and get node-pty for free) or Tauri (and use a Rust PTY library like `portable-pty`).

**Sources:**
- [node-pty GitHub](https://github.com/microsoft/node-pty)
- [xterm.js](https://xtermjs.org/)
- [VS Code Architecture Overview (SkyWork)](https://skywork.ai/skypage/en/VS-Code-Architecture-Overview/1977611814760935424)

---

## 3. Webview Panels

### How They Work

Webview panels are **sandboxed iframes** within VSCode that extensions can create to display custom HTML content:

- Each webview runs in an **isolated context** -- separate from the renderer and from other webviews
- **JavaScript is disabled by default** -- must be explicitly enabled with `enableScripts: true`
- Local resources must be loaded via `Webview.asWebviewUri()` -- direct file:// access is blocked
- Communication uses **`postMessage()` API** -- JSON messages passed back and forth

### Communication Pattern

```
Extension (Extension Host, Node.js)
    |
    | acquireVsCodeApi().postMessage(data)
    | onDidReceiveMessage(handler)
    |
Webview (isolated iframe, Chromium)
```

Extensions can send messages to webviews and receive messages back, but everything is serialized JSON -- no shared memory or direct function calls.

### Limitations for Rich UIs

- **No DOM access from extensions**: Extensions cannot manipulate the webview DOM directly
- **No shared state**: All state must be serialized across the message boundary
- **Restricted resource loading**: Only whitelisted URIs can be loaded
- **No cross-webview communication**: Each webview is fully isolated
- **Performance overhead**: Message serialization adds latency for high-frequency updates

### Relevance to autonomOS

If autonomOS were built as a VSCode extension, webviews would be our only option for custom UI. This is precisely why Cursor, Windsurf, and others **fork** VSCode instead of building extensions -- the webview API is too restrictive for deeply integrated AI experiences. autonomOS should not be constrained by these limitations.

**Sources:**
- [Webview API (VS Code Docs)](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Messenger (TypeFox)](https://www.typefox.io/blog/vs-code-messenger/)

---

## 4. Extension Host

### Process Architecture

The Extension Host is a **dedicated Node.js process** (since the sandbox migration, it runs as an Electron **Utility Process**) that:

- Loads and runs all installed extensions for a window
- Provides the `vscode` API module to extensions
- Communicates with the renderer via **MessagePort + JSON-RPC**
- Can spawn arbitrary child processes (full Node.js access)

### Three Types of Extension Hosts

| Type | Runtime | Where |
|------|---------|-------|
| **Local** | Node.js | Same machine as the UI |
| **Web** | Browser WebWorker | In the browser (VS Code for Web) |
| **Remote** | Node.js | Container, SSH host, or remote server |

### Why This Matters for Subprocess Management

The Extension Host pattern is directly relevant to how autonomOS would manage Claude Code sessions:

- The Extension Host proves that **running arbitrary Node.js processes alongside a sandboxed Chromium UI** works well at scale
- Extensions freely spawn child processes (language servers, linters, formatters) -- exactly like spawning Claude Code
- The RPC pattern (proxy objects on both sides, serialized messages) is battle-tested for this use case
- One Extension Host per window means process isolation per workspace

### Lazy Activation

Extensions declare **activation events** in their `package.json`. They only load when triggered -- not at startup. This keeps startup fast even with many installed extensions. autonomOS should adopt a similar pattern for agent plugins.

**Sources:**
- [Extension Host (VS Code Docs)](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [Extension Development (DeepWiki)](https://deepwiki.com/microsoft/vscode-wiki/5-extension-development)

---

## 5. Performance and Size

### Binary Size

| Metric | Value |
|--------|-------|
| **Download size** | ~100-120 MB (compressed) |
| **Installed size** | ~400-500 MB (macOS .app bundle) |
| **Minimum disk** | 200 MB required |

The bulk of this is Chromium (~100 MB) and Node.js (~30 MB) bundled by Electron.

### Memory Usage

| Scenario | Typical RAM |
|----------|-------------|
| **Fresh window, no extensions** | ~300-400 MB |
| **Typical use (5-10 extensions)** | ~500 MB - 1 GB |
| **Heavy use (many extensions, large projects)** | 1-3 GB |
| **Extreme (many windows, remote dev)** | 3-7 GB+ |

Each process contributes: renderer (~150-300 MB), extension host (~100-300 MB), shared process (~50-100 MB), plus per-terminal and per-language-server overhead.

### Startup Time

VSCode achieves **~1-2 second startup** on modern hardware through aggressive optimization:

1. **V8 Snapshots**: Pre-initialized V8 heaps for framework code, used since 2017. The Atom team demonstrated 50% startup improvement with this technique.
2. **V8 Code Caching**: Chromium's `bypassHeatCheck` option for immediate code caching.
3. **Bundling**: All modules bundled to avoid `require()` overhead (synchronous `require()` is the #1 startup bottleneck in Electron apps).
4. **Lazy Loading**: Extensions only activate on demand; UI parts render incrementally.
5. **ASAR Archives**: Reduce file count for faster I/O.

### How VSCode Monitors Performance

- Tracks **keystroke latency**, **input latency**, and **time-to-interactive** across releases
- Built-in Process Explorer (`Help > Open Process Explorer`) shows per-process CPU/memory
- `code --status` CLI command for process snapshots
- Production telemetry with anonymized performance metrics

**Sources:**
- [6 Ways to Improve Electron Performance (Palette)](https://palette.dev/blog/improving-performance-of-electron-apps)
- [VS Code Requirements](https://code.visualstudio.com/docs/supporting/requirements)
- [V8 Snapshots Experiment (GitHub)](https://github.com/RaisinTen/electron-snapshot-experiment)

---

## 6. Build and Distribution

### Build System

VSCode uses a **Gulp.js-based build pipeline** that produces:
- Compiled JavaScript in `out-vscode/`
- Source maps for debugging
- Platform-specific native modules (node-pty, etc.)
- Final Electron application packages for Windows, macOS, and Linux

### Distribution Formats

| Platform | Format | Update Mechanism |
|----------|--------|------------------|
| **macOS** | `.dmg` / `.zip` (universal binary) | Squirrel.Mac |
| **Windows** | NSIS installer, User/System variants | Squirrel.Windows / NSIS updater |
| **Linux** | `.deb`, `.rpm`, `.snap`, `.tar.gz` | apt/yum repos, snap store |

### Auto-Update

VSCode uses Electron's built-in auto-updater backed by **Squirrel**:

1. App checks for updates at startup, then every 10 minutes
2. Downloads update in background
3. Prompts user to restart to apply
4. On Windows: Squirrel handles differential updates
5. On macOS: Squirrel.Mac replaces the app bundle

For a custom Electron app, **electron-builder** provides the same capabilities out of the box with `electron-updater`, supporting GitHub Releases, S3, and generic HTTP servers as update sources.

### Code Signing

- **macOS**: Requires Apple Developer Program enrollment, Xcode certificates, and notarization
- **Windows**: Code signing certificates (EV certificates eliminate SmartScreen warnings)
- **Linux**: Package signing for apt/yum repos

### What This Means for autonomOS

The build/distribution story for Electron is **mature and well-tooled**. electron-builder handles most of the complexity. The main cost is:
- Apple Developer Program ($99/year) for macOS distribution
- Code signing certificates for Windows (~$200-500/year)
- CI/CD pipeline for cross-platform builds

**Sources:**
- [electron-builder](https://www.electron.build/)
- [Electron Code Signing Docs](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron Auto-Update Docs](https://www.electronjs.org/docs/latest/tutorial/updates)

---

## 7. Forks and Derivatives

### Who Forks VSCode and Why

| Fork | Company | Primary Differentiation |
|------|---------|------------------------|
| **Cursor** | Anysphere | Inline AI code generation, full context awareness |
| **Windsurf** | Codeium | "Cascade" deep contextual AI, auto-write mode |
| **Void** | Open source | Privacy-first, connect your own LLM provider |
| **Antigravity** | — | Another AI-focused fork |

### Why They Fork Instead of Building Extensions

The core reason is **VSCode's extension API is too restrictive for deep AI integration**:

1. **Chat UI**: VS Code's chat API only allows partial customization -- no control over layout, styling, or interaction patterns
2. **Overlay rendering**: Extensions cannot render into built-in views (Explorer, Terminal, etc.)
3. **User activity tracking**: No API to observe everything a user does across built-in views
4. **Terminal access**: Terminal APIs require proposed/limited contracts
5. **Full debugging control**: Multi-session debugging orchestration isn't reliably available
6. **Governance risk**: Competing with Microsoft's Copilot while depending on their distribution

### Maintenance Burden

Maintaining a VSCode fork is **expensive and ongoing**:

- **Monthly rebasing**: Every VS Code release brings integration work. Teams must either lag behind or staff an ongoing rebase team.
- **Extension marketplace access**: Microsoft blocked core extensions (C/C++, Python debugger) from working in forks in 2025, forcing Cursor and others to implement open-source alternatives.
- **Licensing restrictions**: Core Microsoft extensions are only licensed for use in VS Code proper.
- **Distribution**: Microsoft stopped turning a blind eye to forks using their marketplace.

### Alternatives to Full Forking

- **Eclipse Theia**: Open-source framework for building custom IDEs. Supports VS Code extensions via Open VSX. Used by Arduino IDE 2.0. Allows full UI customization without forking.
- **Extension-only approach**: Works for simpler integrations but hits walls for deep AI features.
- **Custom shell using Monaco**: Embed just the Monaco editor (MIT-licensed) in your own Electron/Tauri app.

### What This Means for autonomOS

autonomOS should **not fork VSCode**. We're not building an IDE -- we're building a mission control dashboard. The fork tax is enormous and the use case doesn't justify it. Instead:
- Use Monaco editor if we need code editing
- Build our own shell (Electron or Tauri) with xterm.js for terminals
- Design our own UI without inheriting VSCode's layout constraints

**Sources:**
- [Why Cursor, Windsurf Fork VS Code (Eclipse Foundation)](https://blogs.eclipse.org/post/thomas-froment/why-cursor-windsurf-and-co-fork-vs-code-shouldnt)
- [VS Code Fork Wars (OpenReplay)](https://blog.openreplay.com/vs-code-fork-wars-cursor-windsurf-firebase-studio/)
- [What a Difference a VS Code Fork Makes (Visual Studio Magazine)](https://visualstudiomagazine.com/articles/2026/01/26/what-a-difference-a-vs-code-fork-makes-antigravity-cursor-and-windsurf-compared.aspx)

---

## 8. Tauri as an Alternative

Since autonomOS must choose a desktop shell, here's how Tauri compares specifically for our use case.

### Performance Comparison

| Metric | Electron | Tauri |
|--------|----------|-------|
| **Bundle size** | ~244 MB | ~8.6 MB |
| **RAM (idle, single window)** | ~200-300 MB | ~30-40 MB |
| **RAM (6 windows)** | ~409 MB | ~172 MB |
| **Startup time** | 1-2 sec | < 0.5 sec |
| **Initial build time** | ~16 sec | ~81 sec (Rust compilation) |

### Terminal/PTY Support in Tauri

Tauri does support terminal embedding but with a different stack:

- **[tauri-plugin-pty](https://crates.io/crates/tauri-plugin-pty)**: Rust-native PTY plugin, alternative to node-pty
- **[portable-pty](https://crates.io/crates/portable-pty)**: Rust PTY library (used by wezterm)
- **xterm.js**: Still used for the frontend (same as Electron approach)
- **Sidecar pattern**: Tauri can embed and manage external binaries (e.g., a Node.js sidecar)

The Rust PTY libraries are less battle-tested than node-pty in the context of terminal emulators, but they work. Projects like [Terminon](https://github.com/Shabari-K-S/terminon) and [tauri-terminal](https://github.com/marc2332/tauri-terminal) demonstrate the pattern.

### Key Trade-offs for autonomOS

| Factor | Electron | Tauri |
|--------|----------|-------|
| **PTY maturity** | node-pty is the gold standard, used by VSCode | Rust PTY libs work but less proven at scale |
| **Subprocess management** | Node.js `child_process` -- trivial | Rust `Command` + sidecar pattern |
| **Claude Code integration** | Direct: spawn via node-pty, same runtime | Sidecar or Rust subprocess -- works but more glue code |
| **UI framework** | React/Vue/Svelte in Chromium | Same, but via system WebView (cross-browser quirks) |
| **WebView consistency** | Chromium everywhere -- identical rendering | Different engines per OS (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux) |
| **Ecosystem** | Massive, well-documented | Growing rapidly (Tauri 2.0, 35% YoY adoption increase) |
| **Bundle size** | Large (~200+ MB) | Tiny (~10 MB) |
| **Memory** | Heavy | Light |

**Sources:**
- [Tauri vs Electron Performance (Hopp)](https://www.gethopp.app/blog/tauri-vs-electron)
- [tauri-plugin-pty (crates.io)](https://crates.io/crates/tauri-plugin-pty)
- [Tauri Sidecar Docs](https://v2.tauri.app/develop/sidecar/)

---

## 9. Key Takeaways for autonomOS

### Patterns to Adopt from VSCode

1. **Multi-process architecture**: Isolate the terminal/PTY management, UI rendering, and agent orchestration into separate processes. If one agent crashes, it shouldn't take down the dashboard.

2. **MessagePort for IPC**: Use direct process-to-process communication (not routing everything through a main process). This is critical for terminal data throughput.

3. **Lazy activation**: Don't load agent integrations at startup. Activate them on demand, like VSCode's extension activation events.

4. **PTY Host pattern**: Run all terminal/PTY operations in a dedicated host process. This is the proven architecture for managing multiple terminal sessions reliably.

5. **xterm.js for terminal rendering**: This is non-negotiable for web-based terminal UIs. It's the standard, supports WebGL rendering, and is actively maintained by Microsoft.

### Risks of Electron

- **Binary size**: 200+ MB for what could be a relatively simple app
- **Memory overhead**: 300+ MB baseline before doing anything useful
- **Chromium security surface**: Large attack surface from bundled browser
- **Update frequency**: Electron releases are tied to Chromium, requiring regular updates for security

### Risks of Tauri

- **PTY ecosystem immaturity**: Rust PTY libraries exist but are less proven than node-pty at scale
- **WebView inconsistency**: Different rendering engines per OS could cause UI bugs
- **Smaller ecosystem**: Fewer examples, fewer libraries, fewer Stack Overflow answers
- **Rust learning curve**: Higher barrier for contributors who know TypeScript but not Rust

### Minimum Viable Electron Setup for Terminal-Focused App

For autonomOS, a minimal Electron setup would be:

```
Main Process (electron-main)
    |-- Window management
    |-- Auto-update
    |-- System tray / native menus
    |
PTY Host Process (forked from main)
    |-- node-pty instances (one per Claude Code session)
    |-- Session lifecycle management
    |-- Output buffering
    |
Renderer Process (electron-sandbox)
    |-- React/Svelte dashboard UI
    |-- xterm.js terminal panels
    |-- MessagePort IPC to PTY Host
```

This is ~3 processes minimum, scaling with the number of agent sessions.

### How Claude Code Subprocess Management Would Work

In Electron's process model:

1. **Spawning**: PTY Host uses `node-pty.spawn('claude', [...args])` to create a Claude Code session
2. **I/O**: PTY data streams over MessagePort to renderer, rendered by xterm.js
3. **Lifecycle**: PTY Host tracks session state (running, idle, exited), exposes via RPC
4. **Multiple sessions**: Each Claude Code instance is a separate PTY -- managed concurrently by the PTY Host
5. **Observation**: The PTY Host can tap the data stream to extract structured information (token usage, tool calls, etc.) before forwarding to the renderer

In Tauri's model, the same pattern works but with `portable-pty` or `tauri-plugin-pty` instead of node-pty, and Tauri's IPC instead of Electron's MessagePort.

### Concrete Recommendation

**For autonomOS v0, start with Electron.** Here's why:

1. **Terminal is our core feature**: node-pty + xterm.js is the most proven stack for terminal embedding. VSCode, Hyper, and every serious terminal emulator in Electron uses it.

2. **Claude Code is a Node.js tool**: Running it via node-pty in a Node.js host process is the path of least resistance. No sidecar glue, no FFI boundaries.

3. **Faster iteration**: The TypeScript-everywhere stack (renderer + main + PTY host) means faster development for a team that already knows TypeScript.

4. **Well-understood architecture**: VSCode has proven every pattern we need works at massive scale.

5. **Revisit Tauri later**: If binary size or memory becomes a real user complaint (not a theoretical concern), migrating the UI layer to Tauri is feasible since xterm.js works in both. The PTY Host could even remain a Node.js sidecar.

**The 200 MB binary size is a vanity concern for a developer tool.** Every developer already has VSCode, Cursor, or Slack installed -- all Electron apps. What matters is: does the terminal work well, is the dashboard responsive, and can we ship fast.

---

## Appendix: Key Links

- [VSCode Source Code](https://github.com/microsoft/vscode)
- [node-pty](https://github.com/microsoft/node-pty)
- [xterm.js](https://github.com/xtermjs/xterm.js)
- [Electron Docs](https://www.electronjs.org/docs)
- [Tauri Docs](https://v2.tauri.app/)
- [electron-builder](https://www.electron.build/)
- [tauri-plugin-pty](https://crates.io/crates/tauri-plugin-pty)
- [portable-pty](https://crates.io/crates/portable-pty)
- [VS Code Sandbox Migration Blog](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [Eclipse Theia (fork alternative)](https://theia-ide.org/)
