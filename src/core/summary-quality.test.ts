import { describe, expect, it } from "vitest"
import { assessSignalSummaryQuality } from "./summary-quality.js"

describe("assessSignalSummaryQuality", () => {
  it("fails a digest that reads like a chronological session log", () => {
    const result = assessSignalSummaryQuality({
      source: "digest",
      content:
        "Today we investigated issue #899. First we ran gh issue view. " +
        "Then we searched the repo and edited files. Next we ran tests. " +
        "Finally we opened a PR.",
    })

    expect(result.ok).toBe(false)
    expect(result.reasons.join(" ")).toContain("chronological")
  })

  it("passes a distilled digest focused on durable signal", () => {
    const result = assessSignalSummaryQuality({
      source: "digest",
      content:
        "Digest and autosave synopses are scan surfaces, not session logs. " +
        "Operational memories require expiry metadata so closed PR or task " +
        "receipts leave default wake-up without hiding unrelated scoped rows.",
    })

    expect(result.ok).toBe(true)
  })
})
