// SPDX-License-Identifier: AGPL-3.0-or-later
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
import tincan from "./tools/eslint/index.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-types/**",
      "**/node_modules/**",
      "**/coverage/**",
      "spikes/**",
      "docs/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ["./tsconfig.test.json", "./apps/web/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    // Only adapters import vendor libraries (05 §2).
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/db/**", "packages/auth/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "better-sqlite3", message: "Only the db adapter imports better-sqlite3 (05 §2)." },
            { name: "argon2", message: "Only packages/auth imports argon2 (05 §2)." },
          ],
        },
      ],
    },
  },
  {
    // 04 §11: feature modules reach each other only through events, ports and type-only ModuleApi imports.
    files: ["apps/server/src/modules/**/*.ts"],
    plugins: { tincan },
    rules: { "tincan/module-boundary": "error" },
  },
  {
    // Components use semantic tokens only (style guide §3); raw palette classes such as bg-gray-800 are banned.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["Literal", "TemplateElement"].map((type) => ({
          selector: `${type}[${type === "Literal" ? "value" : "value.raw"}=/\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|decoration|accent|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-[0-9]{2,3})?\b/]`,
          message:
            "Use a semantic colour token (bg-bg, text-text-muted, border-border …), not a raw palette class (style guide §3).",
        })),
      ],
    },
  },
  {
    // Tests read arbitrary JSON responses; typing every body would only restate the assertions.
    files: ["**/*.test.ts", "**/testing/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
  { files: ["**/*.js", "**/*.mjs"], ...tseslint.configs.disableTypeChecked },
  prettier,
);
