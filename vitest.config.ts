import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Only runtime source counts. examples/ are run by hand against a real
      // gateway, never in the suite; src/**/types.ts are type-only files
      // with nothing to execute.
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts"],
      reporter: ["text", "json-summary"],
    },
  },
})
