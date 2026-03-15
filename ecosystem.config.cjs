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

module.exports = {
  apps: [
    {
      name: "autonomos",
      script: resolve(__dirname, "packages/server/src/index.ts"),
      interpreter: resolve(__dirname, "packages/server/node_modules/.bin/tsx"),
      cwd: __dirname,
      env: {
        PORT: 3100,
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
