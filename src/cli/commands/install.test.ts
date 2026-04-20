import { describe, expect, it } from "vitest"
import { parseInstallClient } from "./install.js"

describe("parseInstallClient", () => {
  it("defaults to installing both assistants", () => {
    expect(parseInstallClient(undefined)).toBe("both")
  })

  it("accepts explicit single-assistant targets only", () => {
    expect(parseInstallClient("claude")).toBe("claude")
    expect(parseInstallClient("codex")).toBe("codex")
    expect(parseInstallClient("both")).toBeNull()
  })
})
