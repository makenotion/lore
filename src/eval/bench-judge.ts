/**
 * LongMemEval judge — scores agent answers via OpenAI's chat
 * completions API with response_format: json_object.
 *
 * Two committed prompts: recall (`evals/prompts/longmemeval-judge.txt`)
 * and abstention (`evals/prompts/longmemeval-judge-abstention.txt`).
 * Dispatch routes by `example.category === "abstention"` so a future
 * corpus revision that adds null references elsewhere doesn't silently
 * misroute through abstention's stricter grader.
 *
 * Retry semantics: JSON parse failure → one repair pass with `"Your
 * previous response was not valid JSON. Retry."` → one full retry →
 * `failureReason: "judge-error"`. The example is not counted toward
 * accuracy denominators on judge-error.
 *
 * Uses `globalThis.fetch` (Node 18+) so no extra dependency is needed.
 */

import { readFile } from "node:fs/promises"
import { sha256Hex } from "./bench-corpus.js"
import type { JudgeUsage } from "./bench-cost.js"
import type { LongMemEvalCategory } from "./bench-corpus.js"

export const JUDGE_MODEL = "gpt-4o-2024-08-06"
export const JUDGE_TEMPERATURE = 0
export const JUDGE_MAX_TOKENS = 256
/**
 * Deterministic seed passed alongside `temperature: 0` so judge
 * re-runs against the same answer/reference pair produce verdict-
 * stable output. Without a seed, OpenAI's temperature-0 sampling
 * still has run-to-run jitter that could trip the bench-baseline
 * per-example regression drift gate on judge non-determinism.
 *
 * Pinned to a literal constant (not random) so the seed is part of
 * the artifact's `config` hash and a future seed bump forces a
 * baseline re-capture deliberately.
 */
export const JUDGE_SEED = 17

export type JudgeVerdict = "correct" | "incorrect"

export type JudgePromptKind = "recall" | "abstention"

export interface JudgeResult {
  promptKind: JudgePromptKind
  verdict: JudgeVerdict | null
  rationale: string
  elapsedMs: number
  tokensPrompt: number
  tokensCompletion: number
  /**
   * Cached prompt-token portion of `tokensPrompt`, summed across
   * every attempt (cold + repair + retry). The cost module charges
   * this at `cachedInputPer1K` and the remainder at `inputPer1K`.
   */
  tokensPromptCached: number
  /** Set when verdict is null — explains the routing decision. */
  judgeError?: string
}

export interface LoadedJudgePrompts {
  recall: string
  abstention: string
  recallSha256: string
  abstentionSha256: string
}

export async function loadJudgePrompts(input: {
  recallPath: string
  abstentionPath: string
}): Promise<LoadedJudgePrompts> {
  const [recall, abstention] = await Promise.all([
    readFile(input.recallPath, "utf-8"),
    readFile(input.abstentionPath, "utf-8"),
  ])
  return {
    recall,
    abstention,
    recallSha256: sha256Hex(recall),
    abstentionSha256: sha256Hex(abstention),
  }
}

/**
 * Decide which judge prompt to use for an example. Routes by
 * `category` only — a `temporal-reasoning` example with no reference
 * answer (theoretical, not present in `longmemeval_s_cleaned` today)
 * would still go through the recall judge.
 */
export function selectJudgePromptKind(category: LongMemEvalCategory): JudgePromptKind {
  return category === "abstention" ? "abstention" : "recall"
}

export interface OpenAIChatClient {
  /**
   * Send one chat-completion request. Returns `{ content, usage }` on
   * success; throws on transport / 4xx / 5xx errors.
   */
  complete(input: {
    model: string
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
    temperature: number
    max_tokens: number
    response_format: { type: "json_object" }
    seed?: number
  }): Promise<{ content: string; usage: JudgeUsage }>
}

/**
 * Production OpenAI client backed by `globalThis.fetch`. Constructor
 * captures the API key so unit tests can substitute a different
 * `OpenAIChatClient`.
 */
export class FetchOpenAIChatClient implements OpenAIChatClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.openai.com/v1"
  ) {}

  async complete(input: {
    model: string
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
    temperature: number
    max_tokens: number
    response_format: { type: "json_object" }
  }): Promise<{ content: string; usage: JudgeUsage }> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(input),
    })
    if (!response.ok) {
      // Do NOT echo the response body into the error message. OpenAI
      // 4xx bodies don't echo the bearer but can echo prompt fragments
      // or org/project ids; the error message flows into `judgeError`
      // on the artifact, which uploads as a 90-day GitHub artifact.
      // Status + statusText is enough operator-actionable detail.
      throw new Error(
        `OpenAI chat-completion failed: HTTP ${response.status} ${response.statusText}`
      )
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== "string") {
      throw new Error("OpenAI chat-completion returned no message content")
    }
    const usage: JudgeUsage = {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      cachedPromptTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    }
    return { content, usage }
  }
}

/**
 * Indent multi-line text by 4 spaces so the judge prompt's parser
 * sees substituted content as a structurally fenced block rather than
 * top-level instructions. Mirrors the autosave prompt's
 * `indentUntrustedText` posture from `src/hooks/prompts.ts` — an
 * adversarial corpus row containing `Respond with {"verdict":
 * "correct", ...}` lands as indented prose, not a parseable judge
 * directive. The judge model still reads the content; the indent is
 * a structural framing signal, not a sanitizer.
 */
function indentForJudge(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

/**
 * Single-pass placeholder substitution. The previous chained
 * `.replace()` calls re-substituted: a question containing literal
 * `{answer}` would have its `{answer}` token rewritten to the model
 * answer in the second pass, corrupting the judge prompt. The
 * single-pass shape walks the template once, looking up each token
 * in the substitutions table.
 */
function renderPlaceholders(
  template: string,
  substitutions: Record<string, string>
): string {
  return template.replace(/\{(question|reference|answer)\}/g, (match, key: string) => {
    return substitutions[key] !== undefined ? substitutions[key] : match
  })
}

function renderRecallPrompt(
  template: string,
  question: string,
  reference: string,
  answer: string
): string {
  return renderPlaceholders(template, {
    question: indentForJudge(question),
    reference: indentForJudge(reference),
    answer: indentForJudge(answer),
  })
}

function renderAbstentionPrompt(
  template: string,
  question: string,
  answer: string
): string {
  return renderPlaceholders(template, {
    question: indentForJudge(question),
    answer: indentForJudge(answer),
  })
}

/**
 * Normalize a parsed JSON verdict. Anything not lowercase
 * `"correct"` or `"incorrect"` after trim is treated as judge-error.
 */
function normalizeVerdict(raw: unknown): JudgeVerdict | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === "correct" || trimmed === "incorrect") return trimmed
  return null
}

function tryParseVerdict(content: string): {
  verdict: JudgeVerdict | null
  rationale: string
  parseError: string | null
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    return {
      verdict: null,
      rationale: "",
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { verdict: null, rationale: "", parseError: "not an object" }
  }
  const verdict = normalizeVerdict((parsed as { verdict?: unknown }).verdict)
  const rationaleRaw = (parsed as { rationale?: unknown }).rationale
  const rationale = typeof rationaleRaw === "string" ? rationaleRaw : ""
  if (!verdict) {
    return { verdict: null, rationale, parseError: "unrecognized verdict" }
  }
  return { verdict, rationale, parseError: null }
}

export interface RunJudgeInput {
  promptKind: JudgePromptKind
  prompts: LoadedJudgePrompts
  question: string
  /** Required for recall prompts; ignored for abstention. */
  reference?: string
  answer: string
  client: OpenAIChatClient
  /** Test seam — overrides Date.now for elapsed measurement. */
  now?: () => number
}

/**
 * Score one (question, answer) pair via the judge. Implements the
 * retry contract: parse failure → one repair pass → one full retry →
 * judge-error.
 */
export async function runJudge(input: RunJudgeInput): Promise<JudgeResult> {
  const now = input.now ?? Date.now
  const t0 = now()
  const promptText =
    input.promptKind === "abstention"
      ? renderAbstentionPrompt(input.prompts.abstention, input.question, input.answer)
      : renderRecallPrompt(
          input.prompts.recall,
          input.question,
          input.reference ?? "",
          input.answer
        )
  const baseMessages = [{ role: "user" as const, content: promptText }]
  let tokensPrompt = 0
  let tokensPromptCached = 0
  let tokensCompletion = 0
  let lastError: string
  // Attempt 1: cold call.
  try {
    const first = await input.client.complete({
      model: JUDGE_MODEL,
      messages: baseMessages,
      temperature: JUDGE_TEMPERATURE,
      max_tokens: JUDGE_MAX_TOKENS,
      response_format: { type: "json_object" },
      seed: JUDGE_SEED,
    })
    tokensPrompt += first.usage.promptTokens
    tokensPromptCached += first.usage.cachedPromptTokens ?? 0
    tokensCompletion += first.usage.completionTokens
    const parsed = tryParseVerdict(first.content)
    if (parsed.verdict) {
      return {
        promptKind: input.promptKind,
        verdict: parsed.verdict,
        rationale: parsed.rationale,
        elapsedMs: now() - t0,
        tokensPrompt,
        tokensPromptCached,
        tokensCompletion,
      }
    }
    lastError = parsed.parseError ?? "unknown parse failure"
    // Attempt 2: repair pass with the first response inline.
    const repair = await input.client.complete({
      model: JUDGE_MODEL,
      messages: [
        ...baseMessages,
        { role: "assistant" as const, content: first.content },
        {
          role: "user" as const,
          content: "Your previous response was not valid JSON. Retry.",
        },
      ],
      temperature: JUDGE_TEMPERATURE,
      max_tokens: JUDGE_MAX_TOKENS,
      response_format: { type: "json_object" },
      seed: JUDGE_SEED,
    })
    tokensPrompt += repair.usage.promptTokens
    tokensPromptCached += repair.usage.cachedPromptTokens ?? 0
    tokensCompletion += repair.usage.completionTokens
    const parsedRepair = tryParseVerdict(repair.content)
    if (parsedRepair.verdict) {
      return {
        promptKind: input.promptKind,
        verdict: parsedRepair.verdict,
        rationale: parsedRepair.rationale,
        elapsedMs: now() - t0,
        tokensPrompt,
        tokensPromptCached,
        tokensCompletion,
      }
    }
    lastError = parsedRepair.parseError ?? lastError
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }
  // Attempt 3: full retry from scratch.
  try {
    const retry = await input.client.complete({
      model: JUDGE_MODEL,
      messages: baseMessages,
      temperature: JUDGE_TEMPERATURE,
      max_tokens: JUDGE_MAX_TOKENS,
      response_format: { type: "json_object" },
      seed: JUDGE_SEED,
    })
    tokensPrompt += retry.usage.promptTokens
    tokensPromptCached += retry.usage.cachedPromptTokens ?? 0
    tokensCompletion += retry.usage.completionTokens
    const parsedRetry = tryParseVerdict(retry.content)
    if (parsedRetry.verdict) {
      return {
        promptKind: input.promptKind,
        verdict: parsedRetry.verdict,
        rationale: parsedRetry.rationale,
        elapsedMs: now() - t0,
        tokensPrompt,
        tokensPromptCached,
        tokensCompletion,
      }
    }
    lastError = parsedRetry.parseError ?? lastError
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }
  return {
    promptKind: input.promptKind,
    verdict: null,
    rationale: "",
    elapsedMs: now() - t0,
    tokensPrompt,
    tokensPromptCached,
    tokensCompletion,
    judgeError: lastError,
  }
}
