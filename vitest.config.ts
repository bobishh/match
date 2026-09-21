import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Workspace packages are tested from vendor/meta-mesh/packages. Their npm
    // workspace symlinks under nested node_modules point at the same files and
    // otherwise make Vitest execute the vendored suite twice.
    exclude: ["e2e/**", "**/node_modules/**"],
    setupFiles: ["./src/testSetup.ts"],
  },
})
