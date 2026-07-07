import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", ".cache", "dist"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
