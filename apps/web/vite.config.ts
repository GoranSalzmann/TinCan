// SPDX-License-Identifier: AGPL-3.0-or-later
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = process.env.TINCAN_DEV_SERVER ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Workspace packages export their TypeScript source under this condition (see vitest.config.ts at the root).
  resolve: { conditions: ["tincan-src", "module", "browser", "development"] },
  server: {
    port: 5173,
    // The browser talks only to its own origin; the dev server forwards API and gateway traffic to the app.
    proxy: {
      "/api": target,
      "/gateway": { target, ws: true },
    },
  },
  build: { sourcemap: true, target: "es2022" },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
