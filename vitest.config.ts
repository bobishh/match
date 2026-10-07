import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"

export default defineConfig({
  plugins: [vue()],
  test: {
    // Workspace packages are tested from vendor/meta-mesh/packages. Their npm
    // workspace symlinks under nested node_modules point at the same files and
    // otherwise make Vitest execute the vendored suite twice.
    exclude: ["e2e/**", "tmp/**", "**/node_modules/**"],
    setupFiles: ["./src/testSetup.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/unit",
      include: ["src/**/*.ts", "src/**/*.vue"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/testSetup.ts", "src/vendor/**"],
      reporter: ["text-summary", "html", "json", "json-summary", "lcov"],
      reportOnFailure: true,
      thresholds: { statements: 47, branches: 41, functions: 45, lines: 51 },
    },
  },
})
