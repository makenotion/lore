# LongMemEval corpus

Lore's LongMemEval bench (issue #595) targets the **cleaned** variant of
the `longmemeval_s` dataset published by Wu et al. and re-hosted under
`xiaowu0162/longmemeval-cleaned` on HuggingFace. The "cleaned" variant
removes noisy history sessions that interfere with answer correctness;
it is the upstream-recommended evaluation set.

## Fetch

The corpus is gitignored (the JSON itself is ~50–100 MB). Operators run:

```
lore eval bench fetch longmemeval
```

which downloads the pinned revision from HuggingFace, verifies the
sha256 against `checksums.json`, and writes
`longmemeval_s_cleaned.json` alongside this file. Re-running is
idempotent: a file whose sha256 already matches is not overwritten.

## Pinning

The HuggingFace commit SHA + file sha256 live in `checksums.json`. The
bench runner recomputes sha256 on first read and aborts on mismatch
so a partially-downloaded or substituted corpus cannot silently change
the reported LongMemEval number.

Updating the pin is deliberate work: a new HF revision changes the
input distribution and forces a baseline re-capture under the new
sha. Don't bump without recording the rationale in the PR.

## Load-bearing assumption: every question has its answer in the haystack

The raw-transcript bench prompt
(`evals/prompts/longmemeval-agent-system-raw-transcript.txt`)
instructs the agent that _"every question in this benchmark has its
answer stored verbatim somewhere in the vault"_ and that
_"abstention without retrieval is incorrect."_ That framing is
correct for the published `longmemeval_s_cleaned` corpus by
construction — the upstream cleaning pass removed questions whose
answers were absent from the haystack. If the pinned revision in
`checksums.json` ever moves to a corpus variant that does NOT
satisfy this assumption (e.g. a future `_qa` set that includes
abstention-correct examples), the raw-transcript prompt's posture
will drive false-positive answers when the agent hallucinates
rather than honestly abstaining. The lore-mine prompt
(`evals/prompts/longmemeval-agent-system.txt`) does NOT carry this
assumption and is safe under either corpus posture.

## License

`xiaowu0162/longmemeval-cleaned` is published under the MIT license per
the HuggingFace dataset page. The corpus JSON is downloaded at runtime
and is not redistributed in this repo. License attribution belongs in
any artifact published from a bench run.

## References

- LongMemEval paper: <https://arxiv.org/abs/2410.10813>
- LongMemEval site: <https://xiaowu0162.github.io/long-mem-eval/>
- LongMemEval cleaned dataset on HF: <https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned>
