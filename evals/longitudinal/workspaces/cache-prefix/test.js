import { cacheKey } from "./cache.js"

if (typeof cacheKey("inbox") !== "string") {
  throw new Error("cacheKey must return a string")
}
