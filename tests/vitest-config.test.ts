import { expect, it } from "vitest"
import { configDefaults } from "vitest/config"
import config from "../vitest.config"

const testConfig = config.test ?? {}

it("preserves Vitest's default excludes", () => {
  expect(testConfig.exclude).toEqual(expect.arrayContaining(configDefaults.exclude))
})

it("excludes local agent worktrees from test discovery", () => {
  expect(testConfig.exclude).toEqual(
    expect.arrayContaining([".claude/**", ".codex/**", ".cursor/**"])
  )
})
