module.exports = {
  apps: [
    {
      name: "autonomos",
      script: "packages/server/src/index.ts",
      interpreter: `${process.env.HOME}/.bun/bin/bun`,
      cwd: __dirname,
      env: {
        PORT: 3100,
      },
      // Merge .env file if present
      env_file: ".env",
      // Restart on crash, max 10 restarts in 1 minute
      max_restarts: 10,
      min_uptime: 5000,
      // Watch for server file changes (not dashboard — that needs a rebuild)
      watch: false,
      // Log files
      out_file: "/tmp/autonomos.log",
      error_file: "/tmp/autonomos-error.log",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 5000,
    },
  ],
};
