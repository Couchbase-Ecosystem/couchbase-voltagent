import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
