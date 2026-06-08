// FIRST IMPORT — load-bearing side effect. Must run before any module that
// transitively loads a napi-rs native binding (currently `impit`, via
// server/plugins/claude-usage/scanner.ts).
//
// Why this exists — the universal2 macOS bundle problem:
//
// The server JS is bundled by `bun build` on a SINGLE architecture (arm64 CI
// runner), then lipo'd into a universal2 app. napi-rs's loader is a tree of
// per-arch `require('./impit-node.darwin-<arch>.node')` calls with STATIC string
// literals. Bun resolves each literal against the BUILD host's filesystem at
// bundle time: only the arm64 file exists, so only the arm64 branch keeps a live
// require — every other arch branch is compiled to a `throw new Error("Cannot
// require module ...")` stub. On Intel, the loader reaches only stubs, finds no
// binding, and the server crashes at startup ("impit couldn't load native
// bindings ... not compiled for darwin-x64").
//
// The fix — napi-rs's documented escape hatch NAPI_RS_NATIVE_LIBRARY_PATH:
// when set, its loader `require()`s THAT path first, before any platform/arch
// detection. Because the require argument is `process.env.NAPI_RS_NATIVE_LIBRARY_PATH`
// (not a static literal), bun leaves it as a live runtime require. We point it at
// the pre-lipo'd `impit-node.darwin-universal.node` that stage-universal-server.sh
// stages next to this bundle. dlopen() on the fat binary selects the correct slice
// per arch, so one path works on BOTH architectures.
//
// Scope note: NAPI_RS_NATIVE_LIBRARY_PATH is process-global across ALL napi-rs
// modules. impit is currently the only napi-rs module in the bundle, so this is
// safe. If a second napi-rs native module is ever added, this single-path hook
// would mis-route it — revisit then (e.g. per-module dlopen via createRequire).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin" && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const fatBinding = join(here, "impit-node.darwin-universal.node");
    // Only override when the staged universal binding is actually present. On a
    // normal single-arch build it isn't, and NOT setting the var is correct —
    // napi-rs then loads the host-arch binding directly. This makes the shim a
    // no-op everywhere except inside the universal2 bundle.
    if (existsSync(fatBinding)) {
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH = fatBinding;
    }
  } catch {
    // Path resolution can only fail in exotic runtimes; falling through to
    // napi-rs's normal per-arch loader is the correct single-arch behavior.
  }
}
