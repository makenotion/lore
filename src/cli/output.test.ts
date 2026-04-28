import { describe, expect, it } from "vitest"
import { maybeTerminalLink, notionPageUrl } from "./output.js"

const URL = "https://notion.so/abc123"
const TTY_NO_ENV = { isTTY: true, env: {} as NodeJS.ProcessEnv }

function osc8(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}

describe("maybeTerminalLink", () => {
  it("emits a well-formed OSC 8 sequence under TTY with no env overrides", () => {
    expect(maybeTerminalLink("hello", URL, TTY_NO_ENV)).toBe(osc8("hello", URL))
  })

  it("returns plain text under non-TTY", () => {
    expect(
      maybeTerminalLink("hello", URL, { isTTY: false, env: {} as NodeJS.ProcessEnv })
    ).toBe("hello")
  })

  it("returns plain text when NO_COLOR is set, even under TTY", () => {
    expect(
      maybeTerminalLink("hello", URL, {
        isTTY: true,
        env: { NO_COLOR: "1" } as NodeJS.ProcessEnv,
      })
    ).toBe("hello")
  })

  it("returns plain text when LORE_NO_HYPERLINKS is set, even under TTY", () => {
    expect(
      maybeTerminalLink("hello", URL, {
        isTTY: true,
        env: { LORE_NO_HYPERLINKS: "1" } as NodeJS.ProcessEnv,
      })
    ).toBe("hello")
  })

  it("treats LORE_NO_HYPERLINKS=0 / =false / empty as NOT disabled", () => {
    // Operators who export `LORE_NO_HYPERLINKS=0` to be explicit about *off*
    // should still see hyperlinks — a bare truthiness check would invert
    // their intent.
    for (const value of ["0", "false", ""]) {
      expect(
        maybeTerminalLink("hello", URL, {
          isTTY: true,
          env: { LORE_NO_HYPERLINKS: value } as NodeJS.ProcessEnv,
        })
      ).toBe(osc8("hello", URL))
    }
  })

  it("strips C0 controls and DEL from text before emission", () => {
    // Mix of C0 (\x00-\x1F) and DEL (\x7F) bytes interleaved with printable
    // characters. The escape sequence wrapping the printable label must not
    // contain any of those bytes.
    const dirty = "h\x00e\x01l\x1Bl\x7Fo"
    const out = maybeTerminalLink(dirty, URL, TTY_NO_ENV)
    expect(out).toBe(osc8("hello", URL))
  })

  it("strips an attempted ST terminator (\\x1b\\\\) embedded in text", () => {
    // ESC is in the C0 range so the regex strips it. Both bytes of the ST
    // sequence are removed independently — the trailing backslash survives,
    // which is the intended fallback (printable, harmless).
    const dirty = "be\x1b\\fore"
    const out = maybeTerminalLink(dirty, URL, TTY_NO_ENV)
    expect(out).toBe(osc8("be\\fore", URL))
    // And critically: nothing in the label can prematurely close the link.
    const label = out.slice(
      out.indexOf(URL) + URL.length + 2,
      out.lastIndexOf("\x1b]8;;")
    )
    expect(label.includes("\x1b\\")).toBe(false)
    expect(label.includes("\x07")).toBe(false)
  })

  it("strips an attempted BEL terminator (\\x07) embedded in text", () => {
    const dirty = "be\x07fore"
    const out = maybeTerminalLink(dirty, URL, TTY_NO_ENV)
    expect(out).toBe(osc8("before", URL))
  })

  it("falls back to plain text when the URL fails the Notion safelist", () => {
    // No OSC 8 bytes should ever be assembled — this is the empty-URL guard
    // that prevents "link to nowhere" sequences.
    const out = maybeTerminalLink("hello", "https://evil.example.com/abc", TTY_NO_ENV)
    expect(out).toBe("hello")
    expect(out.includes("\x1b]8;;")).toBe(false)
  })

  it("falls back to plain text when the URL contains a control byte", () => {
    const sneaky = "https://notion.so/abc\x1b]8;;evil"
    const out = maybeTerminalLink("hello", sneaky, TTY_NO_ENV)
    expect(out).toBe("hello")
  })

  it("accepts the www.notion.so variant", () => {
    const out = maybeTerminalLink("hello", "https://www.notion.so/abc123", TTY_NO_ENV)
    expect(out).toBe(osc8("hello", "https://www.notion.so/abc123"))
  })

  it("falls back to plain text when sanitized label is empty", () => {
    // Genuinely empty input.
    expect(maybeTerminalLink("", URL, TTY_NO_ENV)).toBe("")
    // Input that was nothing but stripped control bytes — no affordance to
    // wrap, so we don't pay the OSC 8 byte cost.
    expect(maybeTerminalLink("\x00\x1b\x07", URL, TTY_NO_ENV)).toBe("\x00\x1b\x07")
  })
})

describe("notionPageUrl", () => {
  it("collapses hyphens in a UUID page id", () => {
    expect(notionPageUrl("12345678-90ab-cdef-1234-567890abcdef")).toBe(
      "https://notion.so/1234567890abcdef1234567890abcdef"
    )
  })

  it("passes through a no-dash page id unchanged", () => {
    expect(notionPageUrl("abc123")).toBe("https://notion.so/abc123")
  })
})
