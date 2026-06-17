# @kampus/decisions-index

Generate `.decisions/index.md` from the ADR files (ADR
[0066](../../.decisions/0066-generate-decisions-index.md)).

`.decisions/index.md` is **generated output**, not a hand-maintained file. The
source of truth is each `.decisions/NNNN-*.md` file's YAML front-matter (`id`,
`title`, `status`, `date`); the index table is derived from it, ordered ascending
by `id`. Two doc PRs that add two different ADR files no longer share a textual
anchor (the tail of the table), so they can't collide on `index.md` — the
concurrent-merge friction ADR 0066 removes. The same gate folds in the sibling
problem: a **duplicate ADR `id`** across files fails the check.

## Shape

Per the repo's mechanical-tooling idiom (`leak-guard` / `epic-ledger` /
`crabbox-manifest`): a pure, unit-tested core + a thin Effect CLI bin.

- `src/decisions-index.ts` — the pure core. `buildIndex(files)` parses every
  file's front-matter, fails on a duplicate id (`DuplicateIdError`) or a
  malformed file (`FrontmatterError`), and renders the deterministic table.
  Status/title render **verbatim** (they may carry inline markdown, e.g. a linked
  `superseded by [0009](0009-slug.md)`).
- `src/bin.ts` — the `effect/unstable/cli` bin (`generate` + `check`).

## Usage

```bash
# Rewrite .decisions/index.md from the ADR files (authors / the /adr skill):
pnpm --filter @kampus/decisions-index generate

# CI gate — exit 1 on a stale index OR a duplicate ADR id:
pnpm --filter @kampus/decisions-index check

# Point at a different directory:
node packages/decisions-index/src/bin.ts check --dir path/to/.decisions
```

Exit codes: `0` clean, any non-zero = failure — both a gate failure (stale index
or duplicate id; reason on stderr) and an IO failure (e.g. unreadable dir) exit
non-zero, undistinguished.

CI runs `check` on every PR via
[`.github/workflows/decisions-index.yml`](../../.github/workflows/decisions-index.yml).

## Do not hand-edit `index.md`

Edit the ADR file's front-matter and regenerate. A hand-appended row is exactly
the collision this package removes.
