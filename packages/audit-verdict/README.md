# @kampus/audit-verdict

The **verdict report** of the rite-audit harness — it turns the explorer's per-dimension
findings into one **dated, run-over-run-comparable** result, archived for trend diffing
(issue #1516, epic [#1510](https://github.com/kamp-us/phoenix/issues/1510)).

The rite-audit skill walks the çaylak→yazar rite as an agentic explorer and emits raw
`Finding`s per rubric dimension (functional · accessibility · sandbox-leak); the
[`@kampus/audit-stage`](../audit-stage/README.md) lifecycle provisions the stage those
dimensions run against. This package is the **aggregation + archive** seam: it consumes the
union of the dimensions' `DimensionResult`s and produces one `Verdict` — the durable signal
that a regression happened, not an ephemeral pass/fail.

## The verdict

```ts
interface Verdict {
  date: string;                       // ISO-8601 UTC run timestamp
  target: { stage: string; baseUrl: string };
  overall: "PASS" | "FAIL";
  perDimension: { dimension: string; status: "PASS" | "FAIL" }[]; // sorted by id
  findings: Finding[];                                            // sorted by the triple
}
```

The shape is **stable and ordered by construction** (`perDimension` by dimension id,
`findings` by the comparison key), so a fixed input renders byte-identically — the
precondition for diffing two dated runs mechanically.

### The overall-FAIL rule (story 11)

`overall` is `FAIL` iff **any** dimension is `FAIL`, and a dimension is `FAIL` iff **any**
of its findings is `FAIL` or `BLOCKED` (`BLOCKED` is never a pass). The roll-up is
recomputed from the findings, not trusted from the incoming `DimensionResult.status`, so a
mis-set headline can never mask a broken rite.

### The finding key is the (dimension, check, surface) TRIPLE

Findings are grouped and diffed on the **(dimension, check, surface) triple**, not the
(dimension, check) pair. A dimension runs one check across several surfaces (the a11y and
sandbox-leak dimensions emit one `Finding` per `(check, surface)` pair), so keying on the
pair would collide two distinct findings. The triple keeps them distinct run-over-run. The
contract is stated in the skill's
[`DIMENSIONS.md`](../../claude-plugins/kampus-pipeline/skills/rite-audit/DIMENSIONS.md).

## Archive

Each run lands a `<stamp>-<stage>.json` + `.md` pair under the repo-relative accumulating
run log `rite-audit/runs/`, so successive runs pile up and diff. Every path the artifact
emits is **repo-relative** — `archivePath` constructs from a fixed repo-relative dir and
`assertRepoRelative` fails loud on any absolute/home/escaping path, so no local path leaks
into the archive.

## Architecture

A pure, unit-tested core + a thin Effect bin (the `@kampus/founder-seed` /
`@kampus/preview-seed` idiom — Node Effect tooling, never Python or an ad-hoc shell script):

- `src/schema.ts` — the `Finding` / `DimensionResult` / `Verdict` shapes (the TS rendering
  of the `DIMENSIONS.md` contract).
- `src/verdict.ts` — the pure core: `buildVerdict`, the `dimensionStatus` roll-up, the
  triple `findingKey`, and `diffVerdicts` (the mechanical two-run diff).
- `src/render.ts` — `renderVerdictJson` (canonical machine form) + `renderVerdictMarkdown`
  (human-readable, with each failing finding's evidence).
- `src/archive.ts` — the repo-relative `archivePath` + the `assertRepoRelative` guard.
- `src/verdict.unit.test.ts` — the shape/roll-up/story-11/triple-key/diff/path unit tests.
- `src/bin.ts` — the `audit-verdict archive` CLI.

## Running it

```bash
node packages/audit-verdict/src/bin.ts archive \
  --input <findings.json> --stage <s> --base-url <u> [--date <iso>] [--root <dir>]
```

`--input` is a JSON `{ "dimensions": DimensionResult[] }` (the explorer's raw findings).
The bin writes the verdict's JSON + Markdown to `rite-audit/runs/` under the repo root.

Out of scope: the dimensions that produce the findings (#1513–#1515), and the on-demand
entry point that triggers a run and feeds this verdict (#1517).
