# @phoenix/leak-guard

The enforcement of the repo's **no-local-paths-in-shared-artifacts** rule
(issue #173). A user-local filesystem path (`/Users/<name>/…`, `~/.claude`,
`~/.usirin`, `~/.agent`, `~/code/…`, `/vault/…`) must never enter a committed
doc surface. That rule used to live only in per-skill prose — a reminder every
agent had to remember, and one didn't (a vault path shipped to `main`; see #158).
This package makes the rule mechanical: a **`scan` CLI** that CI runs over the
changed files and fails the build when a leak reaches a doc surface.

It is a `packages/` Effect CLI per the repo's Node-over-Python convention
(mechanical tooling is an Effect CLI package under `packages/`, the
`epic-ledger` / `crabbox-manifest` idiom) — a pure, unit-tested core plus a thin
Effect bin.

## Shape

- **`src/leak-guard.ts`** — the pure, IO-free core. `findLeaks(filePath, text)`
  returns every leak when `filePath` is a shared-artifact doc surface and not
  self-exempt; an empty list otherwise. This is where the matrix lives.
- **`src/bin.ts`** — the `effect/unstable/cli` `scan` command. Takes one or more
  file-path arguments, reads each (a missing/unreadable file is skipped, never a
  crash), runs the core, prints a `<file>: <matched> — <reason>` report. Its
  exit-code contract: **`2`** on a confirmed leak, **`0`** when clean, any other
  **non-zero** means the scan could not run. The two consumers fail-safe in
  opposite directions (issue #332): the **pre-commit hook fail-opens** — it
  blocks only on `2`, and on a can't-run it warns and allows (CI is the
  authority); **CI fail-closes** — any non-zero fails the gate.
- **`src/leak-guard.unit.test.ts`** — the BLOCK/ALLOW matrix, the load-bearing
  false-positive safety.

## What fires, what doesn't

**Shared-artifact surfaces** (where the guard scans): `*.md` / `*.mdx` /
`*.markdown` anywhere, plus the `.decisions/` and `.patterns/` directories.
Arbitrary source (a `/Users` string literal in a `.ts` fixture) is out of scope —
so CI can pass the entire changed-file set and only doc-surface leaks are flagged.

**Leak patterns** — a **precise deny-list** of the specific #158 leak dirs, not a
general bare-`~/` catch-all (blocked in a shared artifact):

| pattern | reason |
| --- | --- |
| `/Users/<name>/…` | absolute macOS home path |
| `~/.claude`, `~/.usirin`, `~/.agent` | agent/tool home dir |
| `~/code/…` | home-dir sibling-repo clone |
| `/vault/…` | vault path |

The deny-list is deliberately precise: it names ONLY the dirs that leak this
machine's identity. Any other `~/<x>` — `~/.config`, `~/.alchemy` (a documented
tool dir; see [.patterns/alchemy-ci-cd.md](../../.patterns/alchemy-ci-cd.md)),
`~/Documents` — **passes**, because it carries no user identity. (This drops the
old brittle `~/.config` carve-out on a general `~/` catch-all and its
`~/.config-backup` boundary edge cases.)

**Allowlist** (never flagged): repo-relative paths (`apps/web/…`,
`.claude/skills/…`); bare `/tmp/…` scratch (it encodes no user identity); any
non-deny-list `~/<x>` home dir (`~/.config/…`, `~/.alchemy/…`, `~/Documents/…`);
`/Users` inside non-doc source; and `DOC_SELF_EXEMPT` path-hygiene files — this
package's own source, the `review-doc` / `triage` / `report` skills,
`report/footer.sh`, and the root `CLAUDE.md` (whose Lineage section deliberately
names `~/code/…` sibling-repo clones) — which must spell the forbidden tokens out
as patterns.

## Wiring

Enforcement is a CI step (a separate PR): the workflow collects the PR's changed
files and runs `scan` over them; a non-zero exit fails the check. The `scan`
command can be handed every changed file because `findLeaks` already scopes to
doc surfaces.

The `scan` CLI cannot see `gh issue`/`gh pr` bodies (those are not committed
files); the `review-doc` gate + the `report` footer contract remain the net for
posted bodies. This package covers the committed-file half of "shared artifacts",
which is the #158 leak class.

## Commands

```bash
pnpm --filter @phoenix/leak-guard typecheck
pnpm --filter @phoenix/leak-guard test
node packages/leak-guard/src/bin.ts scan path/to/file.md another.md   # exit 2 on a leak, 0 clean, other non-zero = couldn't run
```
