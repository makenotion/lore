import { toolError } from "../../helpers.js"
import { suggestTopicKey, type TopicKeySuggestion } from "../../../core/topic-key.js"
import type { ToolResult } from "./types.js"
import { SUGGEST_KIND_VALUES } from "./types.js"

export interface SuggestTopicKeyArgs {
  title: string
  kind: (typeof SUGGEST_KIND_VALUES)[number]
}

/**
 * Render a `TopicKeySuggestion` as a two-line tool response.
 * Distinguishes "suggestion" from "no
 * suggestion" cleanly so the agent can branch on the first line
 * (`Suggested topic key:` vs `No suggestion`) without parsing the
 * reason.
 */
function renderSuggestKeyResult(result: TopicKeySuggestion): ToolResult {
  const lines =
    result.key !== null
      ? [`Suggested topic key: ${result.key}`, `Reason: ${result.reason}`]
      : [`No suggestion — leave topicKey unset.`, `Reason: ${result.reason}`]
  return {
    content: [{ type: "text", text: lines.join("\n") }],
  }
}

export function handleSuggestTopicKey(args: SuggestTopicKeyArgs): ToolResult {
  try {
    const result = suggestTopicKey({ title: args.title, kind: args.kind })
    return renderSuggestKeyResult(result)
  } catch (err) {
    return toolError(err)
  }
}
