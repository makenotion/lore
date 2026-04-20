import { describe, expect, it } from "vitest"
import {
  countTranscriptUserMessages,
  extractTranscriptSessionContent,
  listTranscriptMessages,
} from "./transcript.js"

describe("transcript helpers", () => {
  it("parses Claude-style transcripts", () => {
    const transcript = [
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "text", text: "Investigate the failing build" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'm checking the logs." },
            { type: "tool_use", name: "Bash" },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<system-reminder>ignore</system-reminder>\nThe build fails on Linux only.",
            },
          ],
        },
      }),
    ].join("\n")

    expect(countTranscriptUserMessages(transcript)).toBe(2)
    expect(listTranscriptMessages(transcript)).toEqual([
      { role: "user", text: "Investigate the failing build" },
      { role: "assistant", text: "I'm checking the logs." },
      { role: "user", text: "The build fails on Linux only." },
    ])
  })

  it("parses Codex event transcripts without double-counting mirrored response items", () => {
    const transcript = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "session-1" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "This line should be ignored." }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Fix Lore for Codex.",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "I'm checking Codex docs first.",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "This line should also be ignored." }],
        },
      }),
    ].join("\n")

    expect(countTranscriptUserMessages(transcript)).toBe(1)
    expect(extractTranscriptSessionContent(transcript)).toBe(
      "User: Fix Lore for Codex.\n\nAssistant: I'm checking Codex docs first.",
    )
  })
})
