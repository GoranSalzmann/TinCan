// SPDX-License-Identifier: AGPL-3.0-or-later
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript source under the "tincan-src" condition, so tests and
// `tsx --conditions=tincan-src` run without building first. Production resolves the compiled dist.
const conditions = [...defaultServerConditions, "tincan-src"];
const common = { extends: true as const };
const ignore = ["**/node_modules/**", "**/dist/**", "apps/web/**"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    projects: [
      {
        ...common,
        test: {
          name: "unit",
          include: ["{packages,apps,tools,scripts}/**/*.test.ts"],
          exclude: [...ignore, "**/*.contract.test.ts", "**/*.matrix.test.ts"],
        },
      },
      {
        ...common,
        test: { name: "contract", include: ["packages/**/*.contract.test.ts"], exclude: ignore },
      },
      {
        ...common,
        test: { name: "matrix", include: ["apps/**/*.matrix.test.ts"], exclude: ignore, testTimeout: 30_000 },
      },
      "apps/web",
    ],
  },
});
