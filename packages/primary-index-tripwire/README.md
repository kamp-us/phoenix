# @kampus/primary-index-tripwire

Read-only **attribution** instrumentation for the corruption diagnosed in
[#2778](https://github.com/kamp-us/phoenix/issues/2778): the shared **primary** (non-worktree)
checkout's index accumulating a mass of **staged deletions** of the instruction-trust set
(`.claude/**`, `.decisions/**`, and more) with a clean reflog — the loaded-gun state where one
blind `git commit` + `push` from the primary would land a mass deletion of the control plane on
`origin/main`.

## What it is

A pure, unit-tested detection core (`src/tripwire.ts`) plus a thin Effect CLI (`src/bin.ts`) that,
at commit time, decides whether the staged fileset is the #2778 signature and — on a trip —
**records an attribution event** naming *who* (agent-type, `CLAUDE_CODE_SESSION_ID`) is about to
commit it, *where* (cwd, primary-checkout vs worktree), and *how much* (deletion counts + a sample
of paths).

Staging leaves no reflog trace, so the corrupted index state alone can't say which actor ran the
staging — which is exactly why attribution has to be captured live, at the one caller-agnostic
choke point git itself fires: `pre-commit`.

## What it is NOT

- **It never blocks.** `record` always exits 0. It observes and logs; it does not gate a commit or
  a merge. *Preventing* the staging (scoping worktree git ops, guarding the primary index) and
  *blocking* the dangerous commit are the §CP hardening fix, tracked out of scope of the
  investigation — see [`ops/incidents/2778-primary-index-mass-staged-deletion.md`](../../ops/incidents/2778-primary-index-mass-staged-deletion.md).
- **It never mutates the repo.** Git facts are gathered with read-only plumbing (`git rev-parse`,
  `git diff --cached`); the attribution log is written to an **out-of-repo** path so recording never
  dirties the tree it observes.
- **Its path classifier is not `ship-it`'s `CONTROL_PLANE_RE`.** `CONTROL_PLANE_DELETION_PREFIXES`
  is a deletion-signature heuristic for raising an attribution flag, deliberately independent of the
  merge-blocking control-plane contract — it carries no dependency on it and never moves in lockstep.

## Usage

```bash
# record an attribution event if the staged index is the #2778 signature (else silent), exit 0
node packages/primary-index-tripwire/src/bin.ts record
node packages/primary-index-tripwire/src/bin.ts record --threshold 20 --log /tmp/tripwire.jsonl
```

The attribution log path is `$PRIMARY_INDEX_TRIPWIRE_LOG`, else
`${TMPDIR:-/tmp}/primary-index-tripwire.jsonl`. It is wired as a read-only `pre-commit` leg in the
repo-root `lefthook.yml` (fail-open: a missing toolchain skips, a trip records, the commit always
proceeds).
