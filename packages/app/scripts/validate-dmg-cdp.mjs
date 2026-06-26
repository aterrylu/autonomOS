// CDP-driven validation of the running autonomOS .app. Called by
// validate-dmg.sh after mounting the DMG and launching the app with
// --remote-debugging-port. Exits 0 on full pass, non-zero on any regression.

const CDP_HOST = process.argv[2];
if (!CDP_HOST) {
  console.error("usage: node validate-dmg-cdp.mjs <cdp-http-host>");
  process.exit(1);
}

async function cdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id, method, params })));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    ws.addEventListener("error", (e) => reject(new Error(e.message || "ws error")));
    setTimeout(() => {
      ws.close();
      reject(new Error("cdp timeout"));
    }, 15_000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  return (await fetch(`${CDP_HOST}/json/list`)).json();
}

async function findPage(predicate, maxWaitMs = 15_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    const found = targets.find((t) => t.type === "page" && predicate(t));
    if (found) return found;
    await sleep(500);
  }
  return null;
}

async function main() {
  // Welcome window must render within 10s of launch. (Generous for a cold,
  // contended GitHub macOS runner now that this drives a hard release gate — a
  // genuinely broken build still fails fast; a slow-but-healthy boot doesn't
  // flake-block the release.)
  console.log("[1] looking for Welcome page...");
  const welcome = await findPage(
    (t) => t.title === "autonomOS" && t.url.includes("dist/"),
    10_000,
  );
  if (!welcome) throw new Error("Welcome page never appeared");

  // Welcome must contain the 'Try it out' card with the right class + badge.
  const welcomeState = await cdp(welcome.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: `JSON.stringify({
      cards: Array.from(document.querySelectorAll('.welcome-card')).map(c => ({
        h2: c.querySelector('h2')?.textContent?.trim(),
        badge: c.querySelector('.welcome-card-badge')?.textContent?.trim(),
        hasTryClass: c.classList.contains('welcome-card-try'),
      })),
      // Scan EVERY element in the Welcome-window document for the #176 GPU-peg
      // patterns, not just the first card — a regression could land on any
      // element. (This is the Welcome frame only; the dashboard webview's CSS is
      // not reached here — the Phase-2 OS-level peg-detector is the general
      // backstop for any cause.) Report up to 10 offenders so a failure names it.
      cssCheck: (() => {
        const violations = [];
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          const bf = cs.backdropFilter || cs.webkitBackdropFilter;
          if (bf && bf !== 'none') {
            violations.push({ el: el.className || el.tagName, prop: 'backdrop-filter', val: bf });
          }
          // A non-zero "transition: all" forces per-frame all-property style
          // recalc. The CSS DEFAULT (transition-property:all, duration:0s) is
          // inert and present on every element — only flag a NON-zero one, or
          // we'd false-positive on the whole DOM.
          if (cs.transitionProperty === 'all' && parseFloat(cs.transitionDuration) > 0) {
            violations.push({ el: el.className || el.tagName, prop: 'transition', val: cs.transition });
          }
        }
        return { count: violations.length, sample: violations.slice(0, 10) };
      })(),
    })`,
    returnByValue: true,
  });
  const w = JSON.parse(welcomeState.result.value);
  console.log(`[1] welcome cards: ${w.cards.map((c) => c.h2).join(', ')}`);
  const tryCard = w.cards.find((c) => c.hasTryClass && c.h2 === "Try it out");
  if (!tryCard) throw new Error("'Try it out' card not present on Welcome");
  if (tryCard.badge !== "Try mode") throw new Error(`Try card badge: "${tryCard.badge}" (expected "Try mode")`);
  console.log(`[1] ✓ 'Try it out' card present with badge="${tryCard.badge}"`);
  if (w.cssCheck.count > 0) {
    throw new Error(
      `CPU fix regressed — ${w.cssCheck.count} element(s) use backdrop-filter or ` +
        `non-zero 'transition: all': ${JSON.stringify(w.cssCheck.sample)}`,
    );
  }
  console.log("[1] ✓ CSS CPU-fix invariants hold across all Welcome-window elements (no backdrop-filter, no non-zero `transition: all`)");

  // Click Try-It-Out.
  await cdp(welcome.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: `document.querySelector('.welcome-card-try').click()`,
  });
  console.log("[2] clicked Try-It-Out");

  // Connection window opens; webview inside loads the dashboard.
  const connWindow = await findPage(
    (t) => t.url.includes("dist/renderer/index.html") && t.id !== welcome.id,
    20_000,
  );
  if (!connWindow) throw new Error("connection window never appeared (Try-It-Out spawn failed)");
  console.log(`[3] ✓ connection window opened`);

  // Wait for the auth-bootstrap POST /auth + reload + first-run-UX to settle.
  await sleep(6000);

  // Query the dashboard inside the webview via host-renderer's webview.executeJavaScript.
  const dashState = await cdp(connWindow.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: `(async () => {
      const wv = document.querySelector('webview');
      if (!wv) return { error: 'no webview' };
      try {
        const result = await wv.executeJavaScript(\`
          JSON.stringify({
            hasLoginInput: !!document.querySelector('input[type="password"]'),
            createAgentHeader: !!Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim() === 'Create New Agent'),
            recommendedBadges: Array.from(document.querySelectorAll('span'))
              .filter(s => s.textContent.trim() === 'Recommended')
              .map(s => s.parentElement?.textContent?.slice(0, 80) ?? null),
          })
        \`);
        return { ok: true, data: JSON.parse(result) };
      } catch (err) {
        return { error: err.message };
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  const { ok, data, error } = dashState.result.value;
  if (!ok) throw new Error(`webview query failed: ${error}`);

  console.log(`[4] dashboard state: hasLoginInput=${data.hasLoginInput} createAgentHeader=${data.createAgentHeader} badges=${data.recommendedBadges.length}`);

  if (data.hasLoginInput) {
    throw new Error("dashboard shows login form — auto-auth REGRESSED");
  }
  console.log("[4] ✓ no login form (auto-auth works)");

  if (!data.createAgentHeader) {
    throw new Error("Create Agent panel not visible — first-run UX did not trigger");
  }
  console.log("[4] ✓ Create Agent panel is open (first-run UX fired)");

  if (data.recommendedBadges.length === 0) {
    throw new Error("no 'Recommended' badge — Dispatcher highlight regressed");
  }
  const badgeContext = data.recommendedBadges[0] ?? "";
  if (!badgeContext.toLowerCase().includes("dispatcher")) {
    throw new Error(`Recommended badge not on Dispatcher: "${badgeContext}"`);
  }
  console.log(`[4] ✓ Recommended badge on Dispatcher card`);

  console.log("✅ DMG end-to-end validation PASSED");
}

main().catch((err) => {
  console.error("❌ DMG validation FAILED:", err.message);
  process.exit(1);
});
