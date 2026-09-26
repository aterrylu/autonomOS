// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuthState,
  LINK_LOGIN_ERROR,
  LINK_LOGIN_NO_COOKIE,
  LINK_LOGIN_UNREACHABLE,
  type LinkLoginResult,
  LoginPage,
  settleLinkLogin,
} from "./LoginPage";

/** The sign-in link's inline <script> — the FIRST one in index.html. It runs
 *  before the bundle, so it is tested as the real source, not a copy. */
const INLINE_SCRIPT = (() => {
  const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
  const m = /<head>\s*(?:<meta[^>]*>\s*)*<script>([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!m)
    throw new Error(
      "index.html: sign-in script is not the first script in <head>",
    );
  return m[1];
})();

/** Listeners the script registered, removed after each test (the jsdom
 *  window is shared, so they would otherwise pile up across tests). */
const scriptListeners: Array<[string, EventListenerOrEventListenerObject]> = [];

function openAt(url: string): void {
  window.history.replaceState(null, "", url);
  const add = window.addEventListener;
  window.addEventListener = ((
    type: string,
    fn: EventListenerOrEventListenerObject,
  ) => {
    scriptListeners.push([type, fn]);
    add.call(window, type, fn);
  }) as typeof window.addEventListener;
  // Runs index.html's own inline script (repo source, nothing interpolated).
  try {
    new Function(INLINE_SCRIPT)();
  } finally {
    window.addEventListener = add;
  }
}

describe("index.html sign-in script", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    window.__autonomosLinkLogin = undefined;
  });
  afterEach(() => {
    for (const [type, fn] of scriptListeners.splice(0))
      window.removeEventListener(type, fn);
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("strips #token= from the address bar and POSTs it same-origin", async () => {
    openAt("/agents?tab=1#token=s3cr%2Bt&keep=1");

    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe("/agents?tab=1#keep=1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.signal).toBeInstanceOf(AbortSignal); // bounded: never stuck "Signing you in…"
    expect(JSON.parse(init.body)).toEqual({ token: "s3cr+t" });
    await expect(window.__autonomosLinkLogin).resolves.toEqual({
      ok: true,
      status: 200,
    });
  });

  it("strips the address bar BEFORE the exchange is sent", () => {
    let hrefAtFetch = "";
    fetchMock.mockImplementation(async () => {
      hrefAtFetch = window.location.href;
      return new Response("{}", { status: 200 });
    });
    openAt("/#token=abc");
    expect(hrefAtFetch).not.toContain("abc");
    expect(window.location.href).not.toContain("token");
  });

  it("a legacy ?token= link is stripped and still exchanged (this release)", async () => {
    openAt("/?token=legacy&x=2");
    expect(window.location.search).toBe("?x=2");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      token: "legacy",
    });
  });

  it("a legacy ?token= link leaves a non-token fragment VERBATIM", () => {
    openAt("/?token=legacy#/route");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/route");
  });

  it("the fragment wins when both are present, and both are stripped", () => {
    openAt("/?token=old#token=new");
    expect(window.location.href).not.toContain("token");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      token: "new",
    });
  });

  it("an empty token is refused locally — no request", async () => {
    openAt("/#token=");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    await expect(window.__autonomosLinkLogin).resolves.toMatchObject({
      ok: false,
    });
  });

  it("a refused token resolves not-ok with the status", async () => {
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 401 }),
    );
    openAt("/#token=wrong");
    await expect(window.__autonomosLinkLogin).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("a network failure resolves (status 0) instead of rejecting", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    openAt("/#token=abc");
    await expect(window.__autonomosLinkLogin).resolves.toMatchObject({
      ok: false,
      status: 0,
    });
  });

  it("a link opened in an already-open tab (hash change) reloads to take it", () => {
    openAt("/");
    const reload = vi.fn();
    const real = window.location;
    const spy = vi.spyOn(window, "location", "get").mockReturnValue({
      ...real,
      hash: "#token=abc",
      reload,
    } as Location);
    try {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      expect(reload).toHaveBeenCalledTimes(1);
      spy.mockReturnValue({ ...real, hash: "#pane", reload } as Location);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does nothing on a plain URL", () => {
    openAt("/agents#pane");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.__autonomosLinkLogin).toBeUndefined();
    expect(window.location.hash).toBe("#pane");
  });
});

describe("settleLinkLogin", () => {
  const link = (r: LinkLoginResult) => Promise.resolve(r);
  const probe = (s: AuthState) => () => Promise.resolve(s);

  it("a good link → signed in, no error", async () => {
    await expect(
      settleLinkLogin(link({ ok: true, status: 200 }), probe("authenticated")),
    ).resolves.toEqual({ state: "authenticated", error: "" });
  });

  it("a refused link while signed out → login screen WITH the link error", async () => {
    await expect(
      settleLinkLogin(
        link({ ok: false, status: 401 }),
        probe("unauthenticated"),
      ),
    ).resolves.toEqual({ state: "unauthenticated", error: LINK_LOGIN_ERROR });
  });

  it("an unanswered exchange (network, timeout, 5xx) says so — not 'bad link'", async () => {
    for (const status of [0, 500, 502]) {
      await expect(
        settleLinkLogin(link({ ok: false, status }), probe("unauthenticated")),
      ).resolves.toEqual({
        state: "unauthenticated",
        error: LINK_LOGIN_UNREACHABLE,
      });
    }
  });

  it("an empty #token= (local 400) reads as a refused link", async () => {
    await expect(
      settleLinkLogin(
        link({ ok: false, status: 400 }),
        probe("unauthenticated"),
      ),
    ).resolves.toEqual({ state: "unauthenticated", error: LINK_LOGIN_ERROR });
  });

  it("accepted but still signed out → the cookie didn't stick, and says so", async () => {
    await expect(
      settleLinkLogin(
        link({ ok: true, status: 200 }),
        probe("unauthenticated"),
      ),
    ).resolves.toEqual({
      state: "unauthenticated",
      error: LINK_LOGIN_NO_COOKIE,
    });
  });

  it("a refused link never clears an existing session", async () => {
    await expect(
      settleLinkLogin(link({ ok: false, status: 401 }), probe("authenticated")),
    ).resolves.toEqual({ state: "authenticated", error: "" });
  });

  it("probes only AFTER the exchange settles (no stale-cookie flash)", async () => {
    let release!: (r: LinkLoginResult) => void;
    const pending = new Promise<LinkLoginResult>((r) => {
      release = r;
    });
    const probeFn = vi.fn(async (): Promise<AuthState> => "authenticated");
    const done = settleLinkLogin(pending, probeFn);
    await Promise.resolve();
    expect(probeFn).not.toHaveBeenCalled();
    release({ ok: true, status: 200 });
    await done;
    expect(probeFn).toHaveBeenCalledTimes(1);
  });
});

describe("LoginPage", () => {
  afterEach(cleanup);

  it("shows the link error as an alert", () => {
    render(<LoginPage initialError={LINK_LOGIN_ERROR} />);
    expect(screen.getByRole("alert").textContent).toBe(LINK_LOGIN_ERROR);
  });

  it("shows no alert by default", () => {
    render(<LoginPage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
