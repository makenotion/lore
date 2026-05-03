// Pre-existing Result type the agent should use. The agent should not modify
// this file; verifiers pin it as unchanged.
export const ok = (value) => ({ kind: "ok", value })
export const err = (reason) => ({ kind: "err", reason })
