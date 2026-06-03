# Free Eval Results - 2026-06-03

This report records the no-API-cost eval runs for the skill-retrieval work in
PR #945. Keep the four result tracks separate: the SkillRet keyword run is an
offline string-matching control, the SkillRet Notion AI run is a directional
partial substrate-recall diagnostic, the skill-use run is a
deterministic context sufficiency smoke gate, and the Mail run is a live-vault
read-only retrieval quality check.

The SkillRet keyword lane is not the meaningful Lore measurement. Lore is used
by an instructed LLM agent against a Notion-backed memory vault, so raw query
passes into a search API are only substrate diagnostics. A representative
SkillRet/Lore result requires a stable seeded eval vault, read-only Lore tools,
normal Lore instructions, and scoring that separates tool use, target surfaced,
target selected, and answer/application success. The Notion AI result below is
intentionally labeled directional because the live run was paused after 13 of
20 shards once it had enough signal for product direction.

The SkillRet read-only agent sample is the closer measurement for Lore as an
agent tool. It reuses the existing SkillRet eval vault and import manifest; it
does not reimport the corpus into Notion.

## Summary

| Track                          | Raw artifact                                                     | Result                                                                                                                                                  | Interpretation                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SkillRet keyword retrieval     | `evals/results/skillret-test-keyword-2026-06-03.json`            | 4,997 queries, 6,660 skills, 8,347 qrels. Recall@10 17.51%, NDCG@10 0.1092, MRR@10 0.1049, MAP@10 0.0790.                                               | Offline string-matching control. This is not Lore retrieval, not Notion keyword retrieval, not Notion AI search, and not agent task lift.                                      |
| SkillRet Notion AI directional | `evals/results/skillret-notion-ai-directional-2026-06-04.json`   | 3,250/4,997 queries across 13/20 shards. Recall@10 23.08%, NDCG@10 0.1856, MRR@10 0.2167, MAP@10 0.1480; 0 mechanism failures.                          | Live Notion-backed substrate recall sample. Better than the local keyword control, but below dedicated SkillRet rankers and not representative Lore use.                       |
| SkillRet read-only agent       | `evals/results/skillret-agent-existing-vault-30-2026-06-04.json` | 30 queries against the existing seeded vault. Success 23.33%, tool use 96.67%, target surfaced 73.33%, target expanded 60.00%, selected/applied 23.33%. | Agent-level Lore sample. The agent usually uses Lore and often sees the target, but usually fails to select/apply it. Directional only; the live run hit repeated Notion 429s. |
| Skill-use smoke                | `evals/results/skill-use-smoke-2026-06-03.json`                  | 4/4 required condition checks passed. No-context 0%, oracle 100%, retrieved 100%, retrieved gap to oracle 0.0 pp.                                       | Harness sanity check for support-set/context-sufficiency logic. The default answerer is deterministic, not a powered agent.                                                    |
| Mail retrieval-quality         | `evals/results/mail-retrieval-quality-2026-06-03.json`           | 6/6 required lane checks passed across 3 live-vault cases. Product and RunTool AI lanes recall@1 100%; REST keyword lane recall@10 0%.                  | Live Notion retrieval quality for three labeled Mail cases. Read-only, but raw artifact includes live-vault IDs, returned titles, and explain traces.                          |

## Provenance

| Field                            | Value                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                           | `Iron-Ham/add-free-eval-results`                                                                                                                                                                                          |
| Base commit before report update | `50ca2ed7d16601b5e59a15c0ade7468014a1fbdd`                                                                                                                                                                                |
| Run dates                        | 2026-06-03 and 2026-06-04                                                                                                                                                                                                 |
| Working tree at run time         | SkillRet Notion AI import/run hardening was present in the working tree. The pre-existing untracked `evals/discordant-pairs-manifest.json` was not used. Temporary shard suite files were not committed.                  |
| SkillRet Hugging Face revision   | `7cae7cfbad2b0e1ebc9170892f568993aae543b0`                                                                                                                                                                                |
| SkillRet manifest                | `evals/skill-retrieval/skillret-checksums.json`                                                                                                                                                                           |
| SkillRet eval vault page         | `374b35e6-e67f-8108-beb4-dec11f2f5d28`                                                                                                                                                                                    |
| SkillRet config root             | Operator-local `.lore.yaml` pointing at the registered SkillRet eval vault.                                                                                                                                               |
| SkillRet import manifest         | `evals/skill-retrieval/manifests/skillret-test-import.json` is ignored and operator-local because it contains live Notion page ids. The checked local manifest had 6,660 entries, transform v3, and 14 truncated entries. |
| Mail config root                 | Operator-local production Mail vault.                                                                                                                                                                                     |
| Mail Notion environment          | Dev Notion environment from the Mail `.lore.yaml`.                                                                                                                                                                        |

## Commands

```bash
node dist/cli.js eval skill-retrieval fetch skillret

node dist/cli.js eval run evals/skill-retrieval/skillret-test.yaml \
  --out evals/results/skillret-test-keyword-2026-06-03.json

node dist/cli.js eval run evals/skill-use/smoke.yaml \
  --out evals/results/skill-use-smoke-2026-06-03.json

LORE_CONFIG_ROOT=$HOME/Developer/Notion/Mail \
node dist/cli.js eval run evals/retrieval-quality/mail.yaml \
  --out evals/results/mail-retrieval-quality-2026-06-03.json

NOTION_ENV=dev \
LORE_CONFIG_ROOT=<operator-local-skillret-eval-config> \
node dist/cli.js eval skill-retrieval import \
  evals/skill-retrieval/skillret-notion-ai.yaml \
  --yes \
  --create-project \
  --parallel 3

NOTION_ENV=dev \
LORE_CONFIG_ROOT=<operator-local-skillret-eval-config> \
LORE_EVAL_SKILLRET_REAL=1 \
node dist/cli.js eval run evals/skill-retrieval/.tmp-skillret-notion-ai-shard-XX.yaml \
  --out <operator-local-shard-results>/.tmp-skillret-notion-ai-shard-XX.json

NOTION_ENV=dev \
NOTION_API_TOKEN="$NOTION_DEV_PAT" \
LORE_CONFIG_ROOT=<operator-local-skillret-eval-config> \
LORE_EVAL_BENCH_REAL=1 \
node dist/cli.js eval run <operator-local-skill-agent-suite> \
  --out <operator-local-skill-agent-result>
```

The first Mail run attempt hit a Notion `429` rate limit and did not produce an
artifact. After a 90-second backoff, the retry completed and produced the raw
artifact listed above.

The full SkillRet Notion AI run was split into 20 sequential query shards
because a monolithic run lost several hours to a transient Notion `502`. The
directional artifact commits a merge of the 13 completed shard artifacts
available when the run was paused: shards 01-13, 3,250 unique queries, 0
duplicate query ids. Shard suites were temporary local files and are not part
of the committed artifact set.

## Artifact Inventory

| Path                                                             |   Size | SHA-256                                                            |
| ---------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `evals/results/skillret-test-keyword-2026-06-03.json`            | 9.1 MB | `abcb509afe170ee7f26a2a552c8cc961ca3d36943d357b28df0d4f23dd88e820` |
| `evals/results/skillret-notion-ai-directional-2026-06-04.json`   |  11 MB | `dd69f60f04a1fb3667792b479fbf5fe1f7371cf46b63bc4e023b778b24e411f7` |
| `evals/results/skillret-agent-existing-vault-30-2026-06-04.json` | 234 KB | `70d438518e992f067e21a5e3b7f4f9889ce69aea6365519c38f259b0f0232f3d` |
| `evals/results/skill-use-smoke-2026-06-03.json`                  |  11 KB | `2c5617316cb2aa4584533f65b27f3ad35cdad8a4940435ca2e3319d41012b09d` |
| `evals/results/mail-retrieval-quality-2026-06-03.json`           |  25 KB | `c753e74abe5a37a67e2be6759bdebe1329d458d174b3900523728b6983465d1e` |
| `evals/skill-retrieval/skillret-test.yaml`                       |  suite | `ae30a61a574710e4305e0572e1da4dbd99ceef3e47f2273052c378134d058f8b` |
| `evals/skill-retrieval/skillret-notion-ai.yaml`                  |  suite | `621218eb2efed0c5a734ab477d857f1b1284d59ca4a8d3e8bee477f89db6edfd` |
| `evals/skill-use/smoke.yaml`                                     |  suite | `ff345083b87bdc9d6bb0dbe513a3a8f2f4a4cad80b8b9960d20db0b07b98e523` |
| `evals/retrieval-quality/mail.yaml`                              |  suite | `d40cc7de206c2279b8846881e4fd4cec88fe058dbd07c98215f1632b18e3c794` |

SkillRet corpus hashes matched the pinned manifest:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `data/skills/test.jsonl`  | `4b3db14f528b288077b77207343211dede58f11c15b95a4ced7f6e0f01cbcea9` |
| `data/queries/test.jsonl` | `7475fc12e06c81acb256831dbe25b10cca3c489f23be5774ded034f3bb3877ea` |
| `data/qrels/test.jsonl`   | `12142c4433ffe6c6d6b2b98a277168d35c81338e1b50818eadd8a3c6bb2a6f44` |

Privacy note: committed artifacts are sanitized for review. SkillRet retrieval
artifacts redact raw `results[].query` text while preserving query ids,
expected skill ids, returned skill ids, returned names, returned memory ids,
metrics, summaries, and corpus checksums. The SkillRet agent artifact also
redacts agent answers and replaces Notion memory ids with stable pseudonyms
while preserving scoring fields and tool-trace shapes. The full query text is
recoverable from the pinned public corpus outside the committed artifact. Live
Mail result artifacts replace Notion page/project ids with stable pseudonyms
and redact live-vault titles. Corpus paths are repo-relative rather than
machine-local.

## SkillRet Keyword Retrieval

Suite: `evals/skill-retrieval/skillret-test.yaml`

| Metric       |     @1 |     @5 |    @10 |
| ------------ | -----: | -----: | -----: |
| Recall       | 0.0450 | 0.1203 | 0.1751 |
| Precision    | 0.0586 | 0.0330 | 0.0244 |
| Completeness | 0.0332 | 0.0839 | 0.1205 |
| NDCG         | 0.0586 | 0.0898 | 0.1092 |
| MRR          | 0.0586 | 0.0949 | 0.1049 |
| MAP          | 0.0450 | 0.0714 | 0.0790 |

Additional metrics:

- Queries: 4,997.
- Skills: 6,660.
- Qrels: 8,347.
- Lane: `keyword`.
- Retrieval limit: 10.
- Average estimated context tokens: 205,566.977.
- Average per-query ranking time: 26.73 ms.

This baseline is intentionally simple and intentionally non-representative of
Lore's production retrieval path. It says that an in-process string matcher over
full SkillRet skill text is weak on this public corpus. It does not measure
Notion AI search, Notion keyword search, Lore's production retrieval path, or
whether an agent uses retrieved memory.

## SkillRet Notion AI Directional

Suite: `evals/skill-retrieval/skillret-notion-ai.yaml`

| Metric       |     @1 |     @5 |    @10 |
| ------------ | -----: | -----: | -----: |
| Recall       | 0.1055 | 0.2116 | 0.2308 |
| Precision    | 0.1572 | 0.0649 | 0.0352 |
| Completeness | 0.0628 | 0.1262 | 0.1400 |
| NDCG         | 0.1572 | 0.1787 | 0.1856 |
| MRR          | 0.1572 | 0.2132 | 0.2167 |
| MAP          | 0.1055 | 0.1452 | 0.1480 |

Additional metrics:

- Queries: 3,250 of 4,997, from 13 of 20 sequential shards.
- Coverage: 65.04% of public test queries.
- Skills imported: 6,660.
- Qrels: 8,347.
- Lane: `notion-ai`.
- Retrieval limit: 10.
- Average estimated context tokens: 279.9594.
- Average per-query elapsed time: 5,491.0529 ms.
- Capped results: 1,505.
- Mechanism failures: 0.
- Unknown returned memory ids: 13 across 12 queries, representing 3
  non-manifest memories: `smart-docs`, `nextjs-app-router-patterns`, and
  `laravel-specialist`.
- Rows with at least one relevant result: 1,096 of 3,250.
- Returned relevant judgments: 1,144 of 5,462 relevant judgments represented
  in covered queries.

The imported corpus was structurally valid for the current Lore model. The
local import manifest had 6,660 unique SkillRet entries, transform v3, full
source hashes, rendered content hashes, metadata hashes, topic ids, topic
names, topic keys, and tags on every entry. It used 18 taxonomy topics under
`SkillRet Test Split`, and 14 entries recorded explicit `truncatedFields`
because individual source fields exceeded the stable Notion import cap.

The result is still much lower than published dedicated SkillRet retrieval
systems. This is not primarily because the rows were missing metadata. The
current raw Lore semantic lane passes the full verbose SkillRet query to
Notion AI search, requests exactly the scored top-10 window, and then maps
returned memory ids through the manifest. Lore's project/topic/tag filters for
semantic search are post-filters, so there is no remaining candidate budget to
use topic keys, tags, current-revision manifest membership, or lightweight
reranking after the top-10 comes back. The 13 unknown returned memory ids are
small relative to the sample, but they prove the project-scoped run can still
surface rows outside the current manifest.

The likely Lore-side improvements, without changing Notion search itself, are:

1. Add an over-fetch and post-filter step for manifest-backed evals: request
   the RunTool cap, drop rows outside the current manifest, and score the top
   10 after filtering. Report this as a separate lane from raw `notion-ai`.
2. Add a deterministic query planner for verbose SkillRet prompts: extract a
   short primary task phrase, capability nouns, framework/tool terms, and
   likely domain terms, then union a small number of candidate searches.
3. Add a Lore-side reranker over the over-fetched candidates that combines
   Notion rank with title/name matches, topic key segments, tags, keywords,
   and synopsis/body lexical overlap.
4. Remodel the SkillRet import around activation cards: put skill name,
   description, "when to use" cues, taxonomy, aliases, and disambiguating
   keywords before raw `skill_md`; keep ids and audit metadata in properties
   or at the bottom of the page body.
5. Add current-revision tags to imported SkillRet rows and make the eval lane
   filter or down-rank rows that are not in the active manifest.
6. Add query-time taxonomy planning: infer candidate major/sub topics from the
   query text and use that as a boost or rerank feature, not as a hard filter
   until recall is measured.
7. Use `hybrid` only after enriching `Keywords` and `Synopsis`; today the
   contains leg can only search title, keywords, and synopsis, not the full
   page body.

## SkillRet Read-Only Agent Existing-Vault Sample

Suite: `evals/skill-agent/skillret-readonly-agent.yaml`, with a 30-query
temporary limit and only the required `tool-driven-lore` condition enabled.

This run used the existing registered SkillRet eval vault and
`evals/skill-retrieval/manifests/skillret-test-import.json`. It did not import
or update the SkillRet corpus.

| Metric          |  Value |
| --------------- | -----: |
| Queries         |     30 |
| Passed          |      7 |
| Failed          |     23 |
| Success         | 23.33% |
| Lore tool use   | 96.67% |
| Target surfaced | 73.33% |
| Target expanded | 60.00% |
| Target selected | 23.33% |
| Answer applied  | 23.33% |
| Write attempts  |      0 |

Ranking metrics:

| Metric |     @1 |     @5 |    @10 |
| ------ | -----: | -----: | -----: |
| Recall | 0.1611 | 0.2722 | 0.3056 |
| NDCG   | 0.2000 | 0.2390 | 0.2495 |
| MRR    | 0.2000 | 0.2733 | 0.2775 |
| MAP    | 0.1611 | 0.2067 | 0.2108 |

Failure reasons:

| Failure reason                | Count |
| ----------------------------- | ----: |
| `target-not-selected`         |    23 |
| `answer-did-not-apply-target` |    23 |
| `target-not-expanded`         |    12 |
| `target-not-surfaced`         |     8 |
| `lore-tool-not-used`          |     1 |

The main failure is not that the eval agent refuses to use Lore. It used Lore
in 29 of 30 trials, and the target skill reached the visible candidate set in
22 of 30 trials. The main failure is selection and application after retrieval:
when the target is present, the agent still often chooses a nearby but wrong
skill or returns an answer that does not cite/apply the target skill.

The run was live against Notion and emitted repeated `429` rate-limit warnings,
so the elapsed-time behavior should not be treated as clean throughput data.
The quality signal is still directionally useful: candidate presentation alone
is not enough. The next likely improvements are over-fetch plus manifest
post-filtering, explicit candidate comparison/reranking, and stronger
activation-card content inside the existing SkillRet memories after a deliberate
vault update plan.

## Skill-Use Smoke

Suite: `evals/skill-use/smoke.yaml`

| Condition           | Success | Answer accuracy | Context sufficiency | Harmful rate | Avg context tokens |
| ------------------- | ------: | --------------: | ------------------: | -----------: | -----------------: |
| `no-context`        |    0.0% |            0.0% |                0.0% |         0.0% |                  0 |
| `oracle-context`    |  100.0% |          100.0% |              100.0% |         0.0% |               56.5 |
| `retrieved-context` |  100.0% |          100.0% |              100.0% |         0.0% |               56.5 |
| `harmful-context`   |    0.0% |            0.0% |                0.0% |       100.0% |               53.5 |

Thresholds:

- `minOracleAccuracy: 1` passed.
- `maxNoContextAccuracy: 0` passed.
- `minRetrievedOracleRatio: 1` passed.
- `maxHarmfulContextRate: 0` passed for retrieved context.

This is a smoke test for the support-set machinery. It should not be reported
as powered-agent skill-use accuracy.

## Mail Retrieval-Quality

Suite: `evals/retrieval-quality/mail.yaml`

| Lane           | Cases | Passed | Recall@1 | Recall@5 | Recall@10 | NDCG@10 |    MRR | Harmful@10 | Mechanism failures |
| -------------- | ----: | -----: | -------: | -------: | --------: | ------: | -----: | ---------: | -----------------: |
| `product`      |     3 |      3 |   1.0000 |   1.0000 |    1.0000 |  1.0000 | 1.0000 |     0.0000 |                  0 |
| `runtool-ai`   |     3 |      3 |   1.0000 |   1.0000 |    1.0000 |  1.0000 | 1.0000 |     0.0000 |                  0 |
| `rest-keyword` |     3 |      0 |   0.0000 |   0.0000 |    0.0000 |  0.0000 | 0.0000 |     0.0000 |                  0 |

Per-case required-lane ranks:

| Case                               | Product rank | RunTool AI rank | REST keyword rank |
| ---------------------------------- | -----------: | --------------: | ----------------: |
| `mail-ios-swipeactions-lazyvstack` |            1 |               1 |         not found |
| `mail-ios-webview-jsonencoder`     |            1 |               1 |         not found |
| `mail-notion-multiselect-limit`    |            1 |               1 |         not found |

The required product and RunTool AI lanes passed on all three cases. The
non-required REST keyword baseline failed to find the target memories, which is
useful evidence that the live semantic path is carrying these queries.

Privacy note: the committed Mail artifact preserves ranks, pass/fail state,
cap metadata, explain trace shape, and mechanism traces, but replaces live
Notion ids with stable pseudonyms and redacts live-vault titles.

## Non-Claims

- These runs do not measure autonomous memory formation.
- The SkillRet keyword number is not production Lore retrieval quality and is
  not a SkillRet AI-search result.
- The SkillRet Notion AI number is directional. It covers 13 of 20 shards, not
  the full public test split.
- The SkillRet Notion AI number is raw search substrate recall, not an agent
  using Lore under AGENTS.md-style instructions.
- The SkillRet read-only agent sample is a 30-query live-vault sample, not a
  full 4,997-query agent benchmark.
- The SkillRet number is not a Notion-backed keyword result.
- The skill-use smoke number is not powered-agent task performance.
- The Mail retrieval-quality suite currently has only three labeled cases and
  should not be treated as broad Mail-vault coverage.
- The live Mail run is read-only but still consumes Notion rate-limit budget.
- The live SkillRet Notion AI run is read/write during import and read-only
  during scoring, and it consumes Notion rate-limit budget.

## Next Measurement Work

1. Scale the read-only SkillRet agent lane beyond the 30-query directional
   sample once the candidate-selection surface improves enough to justify more
   live Notion traffic.
2. Add a manifest-filtered over-fetch mode for SkillRet Notion AI runs so Lore
   can request up to the RunTool cap, remove rows outside the active manifest,
   and score top-10 after filtering.
3. Add a Lore-side skill reranker over over-fetched candidates using title,
   topic key, tags, keywords, synopsis, and content overlap features.
4. Add current-revision tags and stricter active-manifest isolation to the
   SkillRet import/run path.
5. Add 30-50 more Mail retrieval-quality cases with domain, cluster,
   difficulty, and harmful near-miss labels.
6. Adapt a larger SkillsBench-style context-use suite into `skill-use` support
   sets.
7. Build a separate formation-transfer suite that gates prior-task success,
   formed-memory quality, retrieval, and later use independently.
