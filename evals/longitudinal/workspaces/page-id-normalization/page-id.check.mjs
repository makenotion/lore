import assert from "node:assert/strict"
import { pageIdKey } from "./page-id.js"

const key = pageIdKey("example")
assert.equal(typeof key, "string")
assert.equal(pageIdKey("example"), key)
