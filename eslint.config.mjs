import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Route handlers and policy checks must match a fixed signature even when
      // a given implementation doesn't need every parameter (e.g. GET handlers
      // with no request body, read-only policy checks with no per-user rule).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Isolated build output used by tests/globalSetup.ts (see next.config.ts NEXT_DIST_DIR).
    ".next-test/**",
  ]),
]);

export default eslintConfig;
