import type { CostOutputCounts } from "../../../core/cost-ledger.js"

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  costOutputs?: CostOutputCounts
}
