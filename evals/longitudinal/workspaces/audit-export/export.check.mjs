import assert from "node:assert/strict"
import { formatAuditEvents } from "./export.js"

const events = [
  { id: "evt-1", action: "login", actor: "ada" },
  { id: "evt-2", action: "logout", actor: "ada" },
]

const output = formatAuditEvents(events)
assert.equal(typeof output, "string")
assert.equal(formatAuditEvents([]), "")
