#!/usr/bin/env node
// Aggregate raw longitudinal eval results across all local result artifacts.
//
// Reads every evals/results/longitudinal-*.json artifact, dedupes to the latest
// result per (scenarioId, condition) by startedAt, and reports raw per-condition
// pass rates plus paired no-memory-vs-memory comparisons with an exact two-sided
// McNemar test on the discordant pairs.
//
// This is DESCRIPTIVE/EXPLORATORY: the corpus mixes calibration runs, reruns, and
// suite versions authored over time, and a single scenario's two arms can come
// from runs with different verifier versions. It is not a predeclared, adjudicated
// holdout sample. Reruns are not counted as independent samples (latest wins).
//
// Usage: node tools/aggregate-longitudinal-results.mjs [resultsDir] [--json]

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const json = args.includes("--json")
const dir = args.find((a) => !a.startsWith("--")) ?? "evals/results"

const files = readdirSync(dir).filter((f) => /^longitudinal-.*\.json$/.test(f))
const latest = new Map() // scenarioId -> condition -> { success, reason, started }
let parsed = 0
let rows = 0

for (const file of files) {
  let artifact
  try {
    artifact = JSON.parse(readFileSync(join(dir, file), "utf8"))
  } catch {
    continue
  }
  if (!Array.isArray(artifact.results)) continue
  parsed++
  const started = String(artifact.startedAt ?? file)
  for (const row of artifact.results) {
    if (!row || !row.scenarioId || !row.condition) continue
    rows++
    if (!latest.has(row.scenarioId)) latest.set(row.scenarioId, {})
    const byCond = latest.get(row.scenarioId)
    const prev = byCond[row.condition]
    if (!prev || started > prev.started) {
      byCond[row.condition] = {
        success: Boolean(row.success),
        reason: row.failureReason ?? null,
        started,
        row,
      }
    }
  }
}

const CONDITIONS = ["no-memory", "seeded-lore", "lore-full-loop"]

function binomCoeff(n, r) {
  let x = 1
  for (let i = 0; i < r; i++) x = (x * (n - i)) / (i + 1)
  return x
}

// Exact two-sided McNemar p-value on discordant counts (b, c).
function mcnemarExact(b, c) {
  const total = b + c
  if (total === 0) return 1
  const k = Math.min(b, c)
  let p = 0
  for (let i = 0; i <= k; i++) p += binomCoeff(total, i) * Math.pow(0.5, total)
  return Math.min(1, 2 * p)
}

function paired(armA, armB) {
  let bothPass = 0
  let harmed = 0 // A pass, B fail
  let lifted = 0 // A fail, B pass
  let bothFail = 0
  const liftedIds = []
  const harmedIds = []
  for (const [scenarioId, byCond] of latest) {
    const a = byCond[armA]
    const b = byCond[armB]
    if (!a || !b) continue
    if (a.success && b.success) bothPass++
    else if (a.success && !b.success) {
      harmed++
      harmedIds.push(scenarioId)
    } else if (!a.success && b.success) {
      lifted++
      liftedIds.push(scenarioId)
    } else bothFail++
  }
  const n = bothPass + harmed + lifted + bothFail
  return {
    n,
    aPass: bothPass + harmed,
    bPass: bothPass + lifted,
    lifted,
    harmed,
    bothPass,
    bothFail,
    delta: lifted - harmed,
    p: mcnemarExact(harmed, lifted),
    liftedIds: liftedIds.sort(),
    harmedIds: harmedIds.sort(),
  }
}

// --- Adjudication helpers (exploratory, single-reviewer, label-unblinded) ---
// Returns whether the use-phase / single verifier actually passed.
function verifierPassed(r) {
  if (!r) return null
  if (Array.isArray(r.verifiers) && r.verifiers.length) return r.verifiers.every((v) => v.passed)
  if (Array.isArray(r.phases)) {
    const use = r.phases.find((p) => p.phase === "use")
    if (use && Array.isArray(use.verifierResults) && use.verifierResults.length)
      return use.verifierResults.every((v) => v.passed)
  }
  return null
}
// formation tripped on a zero-line (whitespace/mode) diff — a now-fixed harness gate
// that skipped Phase B, so there is no behavioral evidence: exclude (needs rerun).
function isFormationGateSkip(r) {
  if (!r || r.success || !Array.isArray(r.phases)) return false
  const f = r.phases.find((p) => p.phase === "formation")
  return (
    f &&
    f.failureReason === "formation" &&
    f.patchStats &&
    f.patchStats.linesAdded + f.patchStats.linesRemoved === 0
  )
}
// Adjudicated outcome: "pass" | "fail" | "exclude". Conservative — verifier
// failures are NOT flipped without transcript review, so lift is a lower bound.
function adjudicated(r) {
  if (!r) return "absent"
  if (r.success) return "pass"
  const reason = r.failureReason ?? "unknown"
  if (reason === "agent-exit") return "exclude" // model-invocation/infra failure
  if (isFormationGateSkip(r)) return "exclude" // now-fixed read-only gate; Phase B skipped
  if (reason === "expected-context" && verifierPassed(r) === true) return "pass" // now-fixed gate
  return "fail"
}

function normalized(armB) {
  let n = 0
  let bothPass = 0
  let lift = 0
  let bothFail = 0
  let harm = 0
  let aN = 0
  let aBothPass = 0
  let aLift = 0
  let aBothFail = 0
  let aHarm = 0
  let excluded = 0
  for (const [, byCond] of latest) {
    const nm = byCond["no-memory"]?.row
    const m = byCond[armB]?.row
    if (!nm || !m) continue
    n++
    if (nm.success && m.success) bothPass++
    else if (nm.success && !m.success) harm++
    else if (!nm.success && m.success) lift++
    else bothFail++
    const na = adjudicated(nm)
    const ma = adjudicated(m)
    if (na === "exclude" || ma === "exclude") {
      excluded++
      continue
    }
    aN++
    if (na === "pass" && ma === "pass") aBothPass++
    else if (na === "pass" && ma === "fail") aHarm++
    else if (na === "fail" && ma === "pass") aLift++
    else aBothFail++
  }
  return {
    armB,
    n,
    bothPass,
    lift,
    bothFail,
    harm,
    contestedRaw: lift + bothFail,
    recoveryRaw: lift / (lift + bothFail || 1),
    excluded,
    aN,
    aLift,
    aHarm,
    aBothPass,
    aBothFail,
    contestedAdj: aLift + aBothFail,
    recoveryAdj: aLift / (aLift + aBothFail || 1),
    adjDelta: aLift - aHarm,
    adjP: mcnemarExact(aHarm, aLift),
  }
}

function ceiling() {
  let triples = 0
  let allPass = 0
  for (const [, byCond] of latest) {
    if (byCond["no-memory"] && byCond["seeded-lore"] && byCond["lore-full-loop"]) {
      triples++
      if (
        byCond["no-memory"].success &&
        byCond["seeded-lore"].success &&
        byCond["lore-full-loop"].success
      )
        allPass++
    }
  }
  return { triples, allPass }
}

const perCondition = {}
for (const cond of CONDITIONS) perCondition[cond] = { pass: 0, total: 0 }
for (const [, byCond] of latest) {
  for (const cond of CONDITIONS) {
    if (byCond[cond]) {
      perCondition[cond].total++
      if (byCond[cond].success) perCondition[cond].pass++
    }
  }
}

const seeded = paired("no-memory", "seeded-lore")
const fullLoop = paired("no-memory", "lore-full-loop")
const ceil = ceiling()
const seededNorm = normalized("seeded-lore")
const fullLoopNorm = normalized("lore-full-loop")

if (json) {
  console.log(
    JSON.stringify(
      {
        artifacts: parsed,
        rows,
        scenarios: latest.size,
        perCondition,
        seeded,
        fullLoop,
        ceiling: ceil,
        normalized: { seeded: seededNorm, fullLoop: fullLoopNorm },
      },
      null,
      2
    )
  )
} else {
  console.log(
    `Parsed ${parsed} artifacts, ${rows} rows; ${latest.size} distinct scenarios.\n`
  )
  console.log("Per-condition (raw, latest-result-per scenario|condition):")
  for (const cond of CONDITIONS) {
    const { pass, total } = perCondition[cond]
    const pct = total ? ((100 * pass) / total).toFixed(1) : "0.0"
    console.log(`  ${cond.padEnd(15)} ${pass}/${total} (${pct}%)`)
  }
  for (const [label, r] of [
    ["seeded-lore", seeded],
    ["lore-full-loop", fullLoop],
  ]) {
    const pct = ((100 * r.delta) / r.n).toFixed(1)
    console.log(`\nPaired no-memory vs ${label}  (n=${r.n}):`)
    console.log(
      `  no-memory ${r.aPass}/${r.n} -> ${label} ${r.bPass}/${r.n}  ` +
        `Δ=${r.delta >= 0 ? "+" : ""}${r.delta} (${pct} pp)`
    )
    console.log(
      `  lifted=${r.lifted} harmed=${r.harmed} both-pass=${r.bothPass} both-fail=${r.bothFail}`
    )
    console.log(
      `  exact McNemar 2-sided p=${r.p.toFixed(4)}` +
        (r.p < 0.05 ? "  (significant)" : "  (not significant @0.05)")
    )
  }

  const cpct = (x, d) => (d ? `${((100 * x) / d).toFixed(1)}%` : "n/a")
  console.log(
    `\nCEILING: ${ceil.allPass}/${ceil.triples} (${cpct(ceil.allPass, ceil.triples)}) full-triple ` +
      `scenarios pass ALL THREE conditions (no headroom).`
  )
  console.log(
    "\nCeiling-normalized (recovery rate among no-memory failures; adjudicated " +
      "excludes infra/now-fixed-gate rows; verifier failures NOT flipped = lower bound):"
  )
  for (const r of [seededNorm, fullLoopNorm]) {
    console.log(`\n  no-memory vs ${r.armB}:`)
    console.log(
      `    RAW  recovery ${r.lift}/${r.contestedRaw} (${cpct(r.lift, r.contestedRaw)} of contested) ` +
        `| harm ${r.harm}/${r.bothPass + r.harm} (${cpct(r.harm, r.bothPass + r.harm)})`
    )
    console.log(
      `    ADJ  excluded=${r.excluded}, n=${r.aN} | recovery ${r.aLift}/${r.contestedAdj} ` +
        `(${cpct(r.aLift, r.contestedAdj)} of contested) | net Δ=${r.adjDelta >= 0 ? "+" : ""}${r.adjDelta} ` +
        `(${cpct(r.adjDelta, r.aN)}) | McNemar p=${r.adjP.toFixed(4)}`
    )
    const disc = r.aLift + r.aHarm
    console.log(
      `    DISCORDANT-only (strips ceiling+floor): ${disc} pairs (lift ${r.aLift} / harm ${r.aHarm}) ` +
        `-> memory wins ${cpct(r.aLift, disc)} of disagreements`
    )
  }
}
