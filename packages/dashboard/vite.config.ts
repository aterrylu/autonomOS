import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.VITE_API_PORT || "3101";
const apiTarget = `http://localhost:${apiPort}`;
const wsTarget = `ws://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
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
