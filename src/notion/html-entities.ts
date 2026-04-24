/**
 * Shared HTML-entity decoder for text that flows through Lore into Notion
 * properties.
 *
 * An upstream producer somewhere in the autosave path (Claude Code rendering
 * transcript context as markdown, or the agent emitting names that quote
 * markup-ish content) has been observed to HTML-encode `&` and kin before
 * the value reaches the MCP boundary. On re-save the already-encoded value
 * gets encoded again. P1-10 fixed this for topic names; this helper is the
 * shared primitive used by every write path that feeds plain-text fields
 * (topics, memory titles + content, fact subjects + objects).
 *
 * Uses `entities.decodeHTML` so the full HTML5 named + numeric entity set is
 * covered; a future upstream producer emitting `&nbsp;`, `&rsquo;`,
 * `&#8217;`, etc. doesn't reopen the bug.
 *
 * The fixed-point loop is the important bit: `decodeHTML("&amp;amp;")` only
 * peels off one layer. Every decoding pass strictly shrinks the string when
 * it changes (the shortest entity is 4 chars and decodes to ≤1), so
 * `input.length` iterations is a principled upper bound. Real-world cases
 * max out at two.
 */
import { decodeHTML } from "entities"

export function decodeTextEntities(input: string): string {
  let current = input
  for (let i = 0; i < input.length; i++) {
    const next = decodeHTML(current)
    if (next === current) return current
    current = next
  }
  return current
}
