import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import boundaries from "./tools/eslint/import-boundaries.js";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.data/**", "apps/web/.next/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
    },
  },
  {
    files: ["packages/**/*.ts", "packages/**/*.js"],
    plugins: { boundaries },
    rules: { "boundaries/only-contracts": "error" },
  },
  {
    // Only apps (composition roots), CLIs and tests may print directly; library code uses the logger.
    files: ["packages/**/src/**/*.ts"],
    ignores: ["packages/db/src/cli/**"],
    rules: { "no-console": "error" },
  },
);
