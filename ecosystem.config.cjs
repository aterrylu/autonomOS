const { readFileSync, existsSync } = require("node:fs");
const { resolve, join } = require("node:path");

// Parse .env file into key-value pairs (pm2's env_file is unreliable)
function loadEnvFile(dir) {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

// Ensure PM2 child gets a rich PATH so binary detection (`which`) works.
// Keep in sync with BINARY_DIRS in packages/server/src/providers/shared.ts.
const HOME = process.env.HOME || "/tmp";
const EXTRA_PATHS = [
  join(HOME, ".local/bin"),
  join(HOME, ".bun/bin"),
  join(HOME, ".npm-global/bin"),
  join(HOME, ".cargo/bin"),
  join(HOME, ".volta/bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/snap/bin",
  "/usr/bin",
  "/bin",
].join(":");

module.exports = {
  apps: [
    {
      name: "autonomos",
      script: resolve(__dirname, "packages/server/src/index.ts"),
      interpreter: resolve(__dirname, "packages/server/node_modules/.bin/tsx"),
      cwd: __dirname,
      env: {
        PORT: 3100,
        PATH: `${EXTRA_PATHS}:${process.env.PATH || "/usr/bin:/bin"}`,
        ...loadEnvFile(__dirname),
      },
      max_restarts: 10,
      min_uptime: 5000,
      watch: false,
      out_file: "/tmp/autonomos.log",
      error_file: "/tmp/autonomos-error.log",
      merge_logs: true,
      kill_timeout: 5000,
    },
  ],
};
