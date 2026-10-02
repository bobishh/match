import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    ignores: [
      "dist/**",
      "iroh-wasm/**",
      "node_modules/**",
      "vendor/**",
    ],
  },
  js.configs.recommended,
  { files: ["src/vendor/**/*.js"], languageOptions: { globals: globals.browser } },
  ...tseslint.configs.recommended,
  ...vue.configs["flat/essential"],
  {
    files: ["src/**/*.{ts,vue}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2025,
      },
      parserOptions: {
        extraFileExtensions: [".vue"],
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      complexity: ["error", 15],
      "max-depth": ["error", 4],
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 120, skipBlankLines: true, skipComments: true },
      ],
      "max-statements": ["error", 60],
      "no-async-promise-executor": "error",
    },
  },
  {
    files: ["src/**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ["src/**/*.test.ts", "src/testSetup.ts"],
    rules: {
      // Negative fixtures intentionally violate runtime contracts. Explicit any
      // still remains forbidden; existing violations are tracked in the baseline.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      complexity: "off",
      "max-depth": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-statements": "off",
      "no-empty": "off",
    },
  },
);
