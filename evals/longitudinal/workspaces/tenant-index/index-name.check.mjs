import assert from "node:assert/strict"
import { indexName } from "./index-name.js"

assert.equal(typeof indexName("tickets"), "string")
assert.ok(indexName("tickets").includes("tickets"))
assert.equal(indexName(""), indexName(""))
