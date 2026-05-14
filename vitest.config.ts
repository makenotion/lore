import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**", ".codex/**", ".cursor/**"],
    setupFiles: ["./tests/setup-runtool-flag.ts"],
  },
})
