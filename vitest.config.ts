import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: "tests/global-setup.ts",
    env: {
      DATABASE_URL: "file:../data/test.db",
      LLM_PROVIDER: "test",
      GEMMA_MODEL: "gemma-4-31b-it",
      UPLOAD_DIR: path.resolve(__dirname, "data/test-uploads"),
      PORT: "8793",
    },
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
