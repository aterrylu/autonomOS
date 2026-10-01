import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { precompress } from "./vite-plugins/precompress";

const apiPort = process.env.VITE_API_PORT || "3101";
// 127.0.0.1, not "localhost": the dev API server binds loopback IPv4 only
// (make dev), and "localhost" can resolve to ::1 first.
const apiTarget = `http://127.0.0.1:${apiPort}`;
const wsTarget = `ws://127.0.0.1:${apiPort}`;

/**
 * The dev server binds THIS MACHINE ONLY by default. It proxies /api, /auth
 * and /ws to the dev API server, so binding all interfaces put that API (and
 * vite's own file serving) on the LAN for as long as `make dev` ran. To use
 * it from another device, opt in explicitly: `make dev-lan` (DEV_HOST=0.0.0.0).
 * vite's default allowedHosts (localhost and raw IPs) covers loopback and LAN
 * access by IP; the old `allowedHosts: true` accepted ANY Host header, which
 * is what lets a DNS-rebinding page talk to the dev server.
 */
export const DEV_HOST = process.env.DEV_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    host: DEV_HOST,
    proxy: {
      "/auth": apiTarget,
      "/api": apiTarget,
      "/ws": {
        target: wsTarget,
        ws: true,
      },
    },
  },
});
