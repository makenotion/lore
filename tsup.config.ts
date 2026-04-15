import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    mcp: "src/mcp/server.ts",
    cli: "src/cli/index.ts",
    "hooks/helpers": "src/hooks/helpers.ts",
  },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  target: "node20",
  banner({ entryPoint }) {
    if (entryPoint === "src/cli/index.ts") {
      return { js: "#!/usr/bin/env node" }
    }
    return {}
  },
})
