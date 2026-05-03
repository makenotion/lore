import { describe, expect, it } from "vitest"
import { dynamicCodeFence } from "./markdown.js"

describe("dynamicCodeFence", () => {
  it("returns 3 backticks for content with no backticks", () => {
    expect(dynamicCodeFence("no fences here")).toBe("```")
  })

  it("returns 3 backticks for content with at most 2 consecutive backticks", () => {
    // 2 backticks in a row don't open a fenced code block (CommonMark
    // requires >= 3), so a 3-backtick outer fence is sufficient.
    expect(dynamicCodeFence("inline `code` here")).toBe("```")
    expect(dynamicCodeFence("``two ticks``")).toBe("```")
  })

  it("returns 4 backticks when content has a 3-backtick run", () => {
    expect(dynamicCodeFence("```js\ncode\n```")).toBe("````")
  })

  it("returns 5 backticks when content has a 4-backtick run", () => {
    expect(dynamicCodeFence("````nested\ncontent\n````")).toBe("`````")
  })

  it("counts the longest run, not the first run", () => {
    const body = "early ``` mid ````` late"
    expect(dynamicCodeFence(body)).toBe("``````")
  })

  it("resets the run counter on non-backtick characters", () => {
    expect(dynamicCodeFence("aa``bb``cc")).toBe("```")
  })

  it("handles an empty string with the minimum fence", () => {
    expect(dynamicCodeFence("")).toBe("```")
  })
})
