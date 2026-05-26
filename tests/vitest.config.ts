import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    root: __dirname,
    include: ["api/**/*.test.ts"],
    globalSetup: [path.resolve(__dirname, "setup/global-setup.ts")],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
  resolve: {
    alias: {
      "@setup": path.resolve(__dirname, "setup"),
    },
  },
});
