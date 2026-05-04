import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

// Structural-detection rule for issue #488. The redaction helper in
// `src/debug-redact.ts` only closes the leak vector if every
// `process.stderr.write` / `process.stdout.write` emitter routes
// through it. This rule fires when a write-to-stream template literal
// interpolates an error message *directly* — `${err.message}`,
// `${error.message}`, `${String(err)}`, `${errorMessage(err)}`, or a
// ternary like `${err instanceof Error ? err.message : err}`. The fix
// is to wrap the interpolation through `redactDebugError(err)` /
// `redactDebugMessage(message)` from `src/debug-redact.ts`.
//
// Both stderr and stdout streams are covered because a future emitter
// that chooses stdout (an MCP-adjacent diagnostic, an installer
// info-level message) faces the same leak threat. None exist in the
// current tree, but pre-emptively covering stdout closes the
// drift-vector cheaply.
//
// The selectors target the direct top-level expression children of
// the template literal, so a wrapped `${redactDebugError(err)}` does
// NOT trip the rule (the immediate template expression is a
// `CallExpression` to `redactDebugError`; `.message` access nested
// inside is invisible to the selector).
//
// Limitations: the rule cannot enforce the contract on every code
// path — a future contributor could route the message through a
// helper function that itself calls `process.stderr.write`. The
// AGENTS.md docs and the redactor docstring describe the contract;
// the lint rule is the cheap mechanical backstop.
const STREAM_WRITE_SELECTORS = ["stderr", "stdout"]
  .map(
    (stream) =>
      `CallExpression[callee.object.object.name="process"]` +
      `[callee.object.property.name="${stream}"]` +
      `[callee.property.name="write"]`,
  )
  // ESLint selector union — match either stream's write call.
  .join(",")

const REDACT_STREAM_RULES = [
  {
    selector: `:matches(${STREAM_WRITE_SELECTORS}) > TemplateLiteral > MemberExpression[property.name="message"]`,
    message:
      "Route error.message through redactDebugError / redactDebugMessage from src/debug-redact.ts before writing to a stdio stream (issue #488).",
  },
  {
    selector: `:matches(${STREAM_WRITE_SELECTORS}) > TemplateLiteral > CallExpression[callee.name="String"]`,
    message:
      "Route String(err) through redactDebugError from src/debug-redact.ts before writing to a stdio stream (issue #488).",
  },
  {
    selector: `:matches(${STREAM_WRITE_SELECTORS}) > TemplateLiteral > CallExpression[callee.name="errorMessage"]`,
    message:
      "Route errorMessage(err) through redactDebugError from src/debug-redact.ts before writing to a stdio stream (issue #488).",
  },
  {
    selector: `:matches(${STREAM_WRITE_SELECTORS}) > TemplateLiteral > ConditionalExpression`,
    message:
      "Route conditional error message through redactDebugError from src/debug-redact.ts before writing to a stdio stream (issue #488).",
  },
]

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-restricted-syntax": ["error", ...REDACT_STREAM_RULES],
    },
  },
  {
    // Tests legitimately drive the helpers with raw error messages to
    // pin contracts; they're never the leak surface and applying the
    // rule there would just produce noise on every fixture.
    files: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  }
)
