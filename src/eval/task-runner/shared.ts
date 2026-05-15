import { resolve } from "node:path"
import type { TaskEvalResult } from "./schema.js"

export function countTasksAllPassed(
  results: Array<Pick<TaskEvalResult, "taskId" | "success">>
): number {
  const successByTask = new Map<string, boolean>()
  for (const result of results) {
    const prior = successByTask.get(result.taskId)
    successByTask.set(result.taskId, (prior ?? true) && result.success)
  }
  let passed = 0
  for (const value of successByTask.values()) if (value) passed++
  return passed
}
export function defaultArtifactPath(suiteName: string, startedAt: string): string {
  const safe = startedAt.replace(/[:.]/g, "-")
  return resolve(process.cwd(), "evals", "results", `${suiteName}-${safe}.json`)
}
