import { z } from "zod"
import {
  DEFAULT_WAKEUP_TASK_LIMIT,
  DEFAULT_WAKEUP_TASK_MEMORY_LIMIT,
} from "../../../core/wakeup.js"

export const contextDispatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({
    action: z.literal("wake-up"),
    mode: z.enum(["full", "task-only"]).optional(),
    projectName: z.string().optional(),
    expand: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    knowledgeFactLimit: z.number().int().min(0).max(50).optional(),
    taskLimit: z.number().int().min(0).max(50).optional(),
    userQuery: z.string().optional(),
    taskMemoryLimit: z.number().int().min(0).max(20).optional(),
    debug: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("digest"),
    period: z.enum(["day", "week"]).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    projectName: z.string().optional(),
  }),
])

export const contextInputSchema = {
  action: z
    .enum(["status", "wake-up", "digest"])
    .describe(
      "Operation: 'status', 'wake-up' (session priming), or 'digest' (raw data)."
    ),
  // wake-up + digest
  projectName: z
    .string()
    .optional()
    .describe("(action='wake-up' or 'digest') Override the auto-detected project."),
  // wake-up
  mode: z
    .enum(["full", "task-only"])
    .optional()
    .describe(
      "(action='wake-up') Retrieval shape. 'full' (default) renders the normal session-start bundle; 'task-only' renders only userQuery-ranked memories plus minimal framing/debug metadata."
    ),
  expand: z
    .boolean()
    .optional()
    .describe(
      "(action='wake-up') Include each memory's markdown body inline (default false). Each body costs one extra Notion round-trip."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "(action='wake-up') Max distinct clusters per memory section after topical collapse."
    ),
  knowledgeFactLimit: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("(action='wake-up') Max active-facts rendered (default 25). 0 skips."),
  taskLimit: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe(
      "(action='wake-up') Max tasks rendered in the Tasks section (default " +
        DEFAULT_WAKEUP_TASK_LIMIT +
        "). 0 skips the section entirely."
    ),
  userQuery: z
    .string()
    .optional()
    .describe(
      "(action='wake-up') Optional short description of the user's current task. When set, fires an additional relevance search seeded by this text and surfaces the hits as a 'For Your Current Task' section above Recent Memories. Truncated to 1000 chars before search. Mirrors the shell hook's P3-05 ranked path, so MCP-direct callers (e.g. after `/clear` or a session pivot) get the same query-aware output."
    ),
  taskMemoryLimit: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe(
      "(action='wake-up') Max memories surfaced for the user's current task (default " +
        DEFAULT_WAKEUP_TASK_MEMORY_LIMIT +
        "). Honored only when 'userQuery' is non-empty. Set 0 to skip the section entirely even when a query is provided."
    ),
  debug: z
    .boolean()
    .optional()
    .describe(
      "(action='wake-up') Include privacy-conscious wake-up coverage counters in the response. Counters include only mode, caps, section counts, and digest age; they never include memory titles, fact text, or the raw userQuery."
    ),
  // digest
  period: z
    .enum(["day", "week"])
    .optional()
    .describe(
      "(action='digest') Time window: 'day' (last 24h) or 'week' (last 7 days). Ignored if since/until provided."
    ),
  since: z
    .string()
    .optional()
    .describe(
      "(action='digest') Custom start (ISO datetime, e.g. 2025-04-14T00:00:00Z). Overrides period."
    ),
  until: z
    .string()
    .optional()
    .describe("(action='digest') Custom end (ISO datetime). Defaults to now."),
}
