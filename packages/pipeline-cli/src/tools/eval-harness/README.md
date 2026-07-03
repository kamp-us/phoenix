# eval-harness

The graded per-stage **corpus** apparatus for the token-economics program (epic
[#1842](https://github.com/kamp-us/phoenix/issues/1842), extending ADR 0112).

## What it is

A typed data model + on-disk format for a **labeled corpus per pipeline stage** — the
version-controlled ground truth every later evaluation slice reads and writes. This first
slice ([#1848](https://github.com/kamp-us/phoenix/issues/1848)) ships the **format + its
decode/encode core** only.

- `CorpusEntry` — one labeled input for one stage: `{ stage, inputRef, label }`, where
  `inputRef` is a reproducible identifier (issue/PR number) and `label` is the known-good
  decision artifact. It is a **discriminated union keyed on `stage`**, so a label whose
  shape doesn't match its stage is unrepresentable (make-invalid-states-unrepresentable):
  - `triage` → `{ type, priority, status }`
  - `write-code` → `{ fixesRef, ciGreen, reviewVerdict }`
  - `review-code` → `{ verdict, acFindings }`
  - `review-doc` → `{ verdict, findings }`
  - `ship-it` → `{ merged, mergeSha }`
- `CorpusManifest` — the frozen ground truth: entries grouped under per-stage keys, each
  key admitting only that stage's entry (the second half of the unrepresentable guarantee).
- `decodeManifest(text)` — total: returns a typed `Result` failure (`malformed-json` or
  `schema-mismatch`) on bad input, never throws. `encodeManifest(manifest)` round-trips it.

## Why it exists

ADR 0112's apparatus grades **one** frozen input per stage with a **binary** oracle —
enough for a deterministic lever flip, not for a stochastic model swap (Opus → Sonnet on a
stage), where an n=1 smoke test can't tell "good enough" from "got lucky." A labeled corpus
big enough for a meaningful pass-rate is the prerequisite for any model-tiering decision.
This module is the shared format that graded slice is built on.

## How to use

The core is a pure library — import `CorpusEntry`, `CorpusManifest`, `decodeManifest`,
`encodeManifest`, and `STAGES` from `corpus.ts`. The one CLI surface validates a manifest
file against the schema:

```bash
pipeline-cli eval-harness check <manifest>   # exit 0 if valid; non-zero on a bad manifest
```

## Out of scope (later children)

Populating real corpus entries, running any stage, and computing any metric (pass-rate,
repair-churn cost) are separate slices under epic #1842 — not this format core.
