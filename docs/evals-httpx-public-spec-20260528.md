# HTTPX Longitudinal Eval Adjudication, 2026-05-28

This records a single validated directional-lift case from the public-spec
HTTPX longitudinal suite. It is a calibration checkpoint and an adjudication
worked example, not a publishable headline benchmark. The sample is one
scenario triple (`n = 1`).

## Scenario

- Suite: `evals/task-suites/longitudinal-httpx-public-spec-v1.yaml`
- Scenario: `httpx-cross-boundary-protocol-epic-v1`
- OSS target: `encode/httpx@301b8fb03a81447c5b5ab1ca991202e10826fbda`
- Difficulty (author-labeled): hard
- Conditions: `no-memory`, `seeded-lore`, `lore-full-loop`
- Agent: codex, 30-minute phase timeout

The scenario crosses four interacting subsystems and asserts behavior with five
deterministic in-process tests (no networked HTTP):

- `params=` encoding percent-encodes `/` and encodes spaces as `+`, while raw
  query strings keep literal `/` and existing percent escapes intact.
- ASGI `scope["raw_path"]` excludes the query string.
- DigestAuth produces the RFC 2069 no-qop response hash and carries cookies
  from a 401 challenge onto the retried request.
- Scheme-prefixed `NO_PROXY` entries become scheme-specific bypasses, not
  wildcard host patterns.

This is the kind of "bigger, cross-boundary" scenario the calibration work is
converging on: it has enough independent failure surface that the model does
not solve it reliably from the prompt alone.

## Raw Artifacts

`evals/results/` is gitignored; these paths are local provenance, not tracked
files.

- no-memory:
  `evals/results/longitudinal-httpx-public-spec-v1-no-memory-calibration-20260528T1413Z.json`
- seeded-lore + lore-full-loop:
  `evals/results/longitudinal-httpx-public-spec-v1-cross-boundary-memory-20260528T1657Z.json`

The memory-arms artifact predates the expected-context harness fix, so it still
records the raw `expected-context` gate on the `lore-full-loop` row.

## Raw Result

Verifier outcomes recorded by the harness, with primary-agent cost separated
from Lore-owned background mining cost:

| Condition        | Raw success | Hidden verifier | Primary-agent cost | Lore mining cost | Elapsed |
| ---------------- | ----------- | --------------- | -----------------: | ---------------: | ------: |
| `no-memory`      | fail        | failed          |              $5.41 |                — |  12.1 m |
| `seeded-lore`    | pass        | passed          |              $3.36 |                — |   7.5 m |
| `lore-full-loop` | fail        | **passed**      |              $3.51 |            $2.97 |  20.3 m |

For `lore-full-loop`, primary-agent cost is the Phase B (use) cost ($3.51); the
$2.97 formation/mining cost is Lore-owned and the 20.3 m elapsed includes the
8.1 m Phase A formation pass plus the 12.2 m Phase B use pass.

The raw `lore-full-loop` failure is `failureReason: expected-context`: both
phases reported `success: true` and the hidden verifier passed, but the old
harness gate failed the row because wake-up did not surface the statically
declared expected-context IDs.

## Adjudication

Under `docs/evals-adjudication-rules.md`, the `lore-full-loop` row converts from
raw fail to **adjudicated pass**:

- Both phases (formation, use) succeeded and the hidden verifier passed.
- The only failing signal was static expected-context matching, which the
  rubric and the repaired harness both treat as a diagnostic, not the task
  outcome.
- The same rule applies symmetrically to every condition.
- A replayable patch evidence sidecar and full transcript exist for the final
  workspace state.

This is the harness-gate case the expected-context fix in
`src/eval/task-runner/longitudinal-runner.ts` addresses: verifier/phase success
now determines task success, expected-context misses stay in lift diagnostics,
harmful surfaced context still fails context satisfaction, and a wake-up that
surfaces context with no static expected IDs can count as context-satisfied.

Failure bucket for the raw row: not `agent-failure`. The implementation was
complete and verified; the raw failure is an artifact of the superseded
expected-context gate.

| Condition        | Adjudicated success |
| ---------------- | ------------------- |
| `no-memory`      | fail                |
| `seeded-lore`    | pass                |
| `lore-full-loop` | pass                |

## Independent Replay Verification

The saved final-state patches were replayed against the strengthened hidden
verifier in a clean checkout of the pinned SHA (2026-05-28):

| Condition        | Replayed patch verifier result |
| ---------------- | ------------------------------ |
| `no-memory`      | fail (command-failed)          |
| `seeded-lore`    | pass                           |
| `lore-full-loop` | pass                           |

Replay command shape:

```bash
cache=~/.cache/lore/eval-workspaces/git/encode/httpx/301b8fb03a81447c5b5ab1ca991202e10826fbda/4f53cda18c2b
work=/tmp/httpx-adj
git clone --quiet "$cache" "$work"
git -C "$work" apply --whitespace=nowarn /abs/path/to/<condition>-use.patch
node tools/validate-task-suite-hidden-verifiers.mjs \
  evals/task-suites/longitudinal-httpx-public-spec-v1.yaml \
  --workspace "$work" \
  --scenario httpx-cross-boundary-protocol-epic-v1 \
  --expect <fail|pass>
```

The patch sidecars live under each artifact's `*-shards/` directory.

## Interpretation

Supported by this single scenario:

- One validated directional-lift case: `no-memory` fails the hidden verifier
  while both `seeded-lore` and (adjudicated) `lore-full-loop` pass it, confirmed
  by independent patch replay.
- On this scenario both memory arms also reduced primary-agent cost versus
  `no-memory` ($3.36 seeded and $3.51 full-loop use-phase, versus $5.41
  no-memory).

Not supported:

- Any statistically significant headline lift, token-reduction, or
  speed-improvement claim. This is `n = 1`.
- A confirmatory adjudication. The adjudication rubric was authored
  contemporaneously with this run rather than strictly predeclared before it, so
  this adjudication is exploratory/directional. Under the rubric, headline
  correctness may use the adjudicated view only when the rubric was predeclared.

## Next Step

Treat this as the calibration anchor for "bigger, cross-boundary" scenario
design. Build additional scenarios in this shape until a stratified hard pool
has a no-memory pass rate in the 20-45% band, then run a fresh predeclared
holdout before any lift claim. Do not spend on memory arms for scenarios whose
`no-memory` row passes during calibration.
