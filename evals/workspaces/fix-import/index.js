// The import below points at a path that does not resolve; the real
// helpers module sits next to this file. Fix the import path; do not
// modify the helpers module.
import { greet } from "./missing/helpers.js"

export function main(name) {
  return greet(name)
}
