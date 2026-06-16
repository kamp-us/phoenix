# @kampus/changelog-derive

The mechanism behind **[ADR 0069](../../.decisions/0069-derived-changelog-from-shipped-work.md)**:
the repo's `CHANGELOG.md` is a **derived projection** of the pipeline's structured
metadata, not a hand-edited doc. Every merged PR closes a triaged issue with a known
title and a `type:*` label (the [`gh-issue-intake-formats.md`](../../skills/gh-issue-intake-formats.md)
contract), so the changelog is a *projection* of facts that already exist — the same
posture as ADR 0022's generated types: regenerate, never hand-maintain.

It is a `packages/` Effect CLI per the repo's Node-over-Python convention (mechanical
tooling is an Effect CLI package under `packages/`, the `epic-ledger` / `leak-guard`
idiom) — a pure, unit-tested core plus a thin `effect/unstable/cli` bin.

## Shape

- **`src/changelog.ts`** — the pure, IO-free core. `deriveChangelog(releases) → markdown`
  is the top-level projection; `groupByType(entries)` buckets entries by mapped category;
  `renderSection(meta, entries)` renders one Keep-a-Changelog `## [version] — date` block.
  The one non-obvious decision the ADR delegated to "the CLI's business" — the `type:*` →
  category map (`TYPE_CATEGORY` / `categoryFor`) — lives and is unit-tested here.
- **`src/bin.ts`** — the `effect/unstable/cli` `derive` command. Reads a gathered entries
  JSON (`--entries`), runs the core, and writes the changelog body to `--out` (default:
  stdout). A malformed/unreadable entries file is a typed failure → a non-zero exit.
- **`src/changelog.unit.test.ts`** — the category map + grouping + rendering matrix.
- **`src/bin.derive.test.ts`** — the end-to-end CLI contract (stdout, `--out`, exit code).

## The `type:*` → Keep-a-Changelog category map

| `type:*` | Category |
|---|---|
| `type:feature` | Added |
| `type:bug` | Fixed |
| `type:chore` | Changed |
| `type:decision` | Decisions |
| `type:investigation` | Changed |
| `type:epic` | Changed |
| *(absent / unknown)* | **Uncategorized** — flagged, never silently dropped |

An entry whose closing issue carries no recognized `type:*` lands in **Uncategorized**
rather than vanishing — the ADR's standing-input-contract consequence (a PR that closes
an issue with no `type:*` surfaces, it doesn't disappear).

## Inputs — the source-preference contract (ADR 0069 §2)

The entries JSON the CLI consumes carries, per entry:

1. **Closed-issue title + triaged `type:*`** — the primary input (the `title` and `type`
   fields). The issue number (`issue`) is the identity.
2. **Merged-PR number** (`pr`) — for the human-readable line's `(#NNN)` backlink. When
   absent the backlink falls back to the issue number.

`git log` between release tags is the **range selector only** (which merges fall in this
release) — never the entry *text*. That gathering lives at the workflow boundary, not in
this package; the CLI is fed the already-selected, already-typed entries.

```jsonc
// entries.json — one release's worth of shipped-work facts
[
  {"issue": 100, "pr": 101, "title": "add changelog-derive CLI", "type": "feature"},
  {"issue": 110, "pr": 111, "title": "fix crash on empty range", "type": "bug"},
  {"issue": 140, "title": "untyped work item"}            // → Uncategorized
]
```

## Run

```bash
# derive one release section to stdout
node packages/changelog-derive/src/bin.ts derive --entries entries.json --version 0.1.0 --date 2026-06-15

# or write the file directly
node packages/changelog-derive/src/bin.ts derive --entries entries.json --version 0.1.0 --out CHANGELOG.md

pnpm --filter @kampus/changelog-derive test       # unit + CLI tests
pnpm --filter @kampus/changelog-derive typecheck
```

## Cadence and trigger

Per-release **batch**, not per-ship (ADR 0069 §3): the CLI runs at release time over the
range since the previous release tag, emitting one `## [version]` section. The trigger is
a [`.github/workflows/`](../../.github/workflows/changelog.yml) release step keyed off the
same `*-v*` release-tag convention [ADR 0064](../../.decisions/0064-epic-ledger-npm-publish-automated-release.md)
established; it runs the CLI and commits the updated `CHANGELOG.md`. That workflow file is
`.github/**` → **control-plane** per [ADR 0053](../../.decisions/0053-control-plane-boundary.md),
so its PR is human-merged. `ship-it` is **not** touched: the changelog is a release-cadence
concern, decoupled from individual merges (the merge actor stays atomic/idempotent, ADR 0048).
