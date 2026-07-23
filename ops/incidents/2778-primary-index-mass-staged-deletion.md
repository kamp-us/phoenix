# Incident diagnosis — primary-index mass staged deletion (#2778)

Investigation of [#2778](https://github.com/kamp-us/phoenix/issues/2778) (`type:investigation`,
`p1`, `axis:pipeline-hardening`). This is the **diagnosis** artifact — a mechanism trace, a
rule-in/out of every candidate vector, a characterization of the containment that caught it, and the
scoped §CP hardening fix it names. The fix itself is out of scope (§CP, merge-by-hand); this unit is
read-only diagnosis + read-only instrumentation.

Related: [#2666](https://github.com/kamp-us/phoenix/issues/2666) (the inbound/milder sibling — see
[§ Same-vs-distinct](#same-vs-distinct-vs-2666)).

## The observed state

Operating from the **primary** (non-worktree) checkout at repo root while worktree-isolated pipeline
agents ran, the primary git **index** held:

- **248 staged deletions** of tracked files under `.claude/**`, `.decisions/**`, and more
  (first-column `D` in `git status`).
- **0 unstaged modifications**, **0 commits ahead** of `origin/main`.
- A HEAD reflog of only clean fast-forward merges — **no** `reset`/`checkout` accounting for the
  staging.

Signature: a `git rm -r --cached`- / `git add`-equivalent run over already-removed paths against the
**primary** index (not a worktree index). Recovery was clean — `git reset --hard origin/main` (0
commits to lose, untracked preserved); origin was never touched. Verified read-only during this
investigation: the primary is back on `main` with 0 staged deletions.

**Key forensic fact:** staging mutates only `.git/index`; it leaves **no reflog trace**. So the
resulting index state is identical whether the staging ran from the primary operator session or from
a worktree agent whose cwd reset to the primary — the state alone cannot attribute the actor. That is
the whole reason the deliverable includes *instrumentation* (below), not just a root-cause name.

## Where a mass staged deletion into the PRIMARY index can come from

Every path by which a pipeline actor's git op can stage into the primary index, each ruled in or out
against the current code:

### 1. Git hooks in the shared `.git` — RULED OUT as the stager

Linked worktrees share the primary `.git`, object store, and hook set. Auditing every hook in
[`lefthook.yml`](../../lefthook.yml):

- **`post-checkout` (`bootstrap-deps`)** — fires on `git worktree add`. It runs
  `pnpm install --prefer-offline --ignore-scripts` and nothing else. It **stages nothing**. (It is
  careful *not* to run lifecycle scripts precisely because the hook set is shared.) Not the stager.
- **`pre-commit` (`leak-guard`, `biome`)** — scan-only; stage nothing.
- **`pre-push` (`typecheck`, `unit-changed`)** — read-only checks; stage nothing.
- **`reference-transaction` (`ref-guard`)** — refuses a *diverging* `refs/heads/main` move; it never
  stages. (Its role in the blast radius is analyzed [below](#is-the-guard-sufficient).)

No git hook stages files. The mass staging came from a **git command run by an actor**, not a hook.

### 2. A managed-worktree agent whose cwd reset to primary — CONTAINED when the guard is active

The leading hypothesis in the issue: a worktree-isolated agent whose Bash cwd silently reset to the
primary checkout between tool calls (the documented `isolation:worktree` cwd-reset) ran an unscoped
staging command there.

The containment against exactly this is the `worktree-guard pre-bash` `PreToolUse` hook
([`packages/pipeline-cli/src/tools/worktree-guard/bash-pin.ts`](../../packages/pipeline-cli/src/tools/worktree-guard/bash-pin.ts),
`pinBash`). For a managed-worktree agent it:

- **refuses** an auto-stage-all op (`git add -A/--all/.`, `git commit -a`) — the #2666 containment;
- **refuses** an unscoped head-moving op (`checkout`/`switch`/`reset`/`rebase`/`stash`/`merge`);
- otherwise **rewrites** the command to `cd "$WORKTREE_ROOT" && <command>`.

That rewrite is the load-bearing fact for this vector: a bare `git add -u` or `git rm -r --cached
.claude/` issued after a cwd reset is rewritten to run **inside the worktree**, so it stages against
the **worktree** index — never the primary. **So when the pre-bash hook is active, a *bare*
reset-cwd staging command cannot reach the primary index.**

Therefore this hypothesis is ruled **in only for a session where the pre-bash hook was NOT active**
— e.g. a session whose plugin hooks were not enabled/installed at `SessionStart`, or a git op issued
outside the `Bash` tool-hook path. Two residual escapes survive even an *active* hook, but both
require the agent to **explicitly name the primary** (not a cwd-reset accident):

- `cd <primary> && git add …` — a leading `cd` is trusted and allowed (the hook does not fight an
  explicit cwd).
- `git -C <primary> add …` / `git -C <primary> rm --cached …` — `add`/`rm` are not in the hook's
  head-moving set and (non-stage-all) are not refused; the `-C <primary>` overrides even the cd-pin
  rewrite.

Neither is a plausible *accidental* mass-deletion. So the cwd-reset-to-primary mechanism reduces to a
single question — **was the pre-bash hook active in the incident session?** If yes, this vector is
closed for bare commands; if no, it is wide open.

### 3. The primary operator / orchestrator session — the ALWAYS-UNGUARDED surface (top suspect)

`pinBash` is **deliberately a no-op for the orchestrator's own shell**: no `$WORKTREE_ROOT`, no
isolation asserted, so it returns `allow` for every command (this is intentional — the orchestrator's
legitimate `git checkout main` ff-reattach must not be refused). The consequence: **any** unscoped
`git add` / `git rm --cached` run in the primary operator session hits the primary index with **no
containment layer at all**, regardless of whether the worktree plugin is enabled.

This surface has no guard in either regime (hook active or not), which makes it the **top suspect**:
an operator/orchestrator-context git op (a cleanup, a botched `git add` after paths were removed, a
tool that staged) against the primary index would produce the exact observed state and leave no
reflog trace.

### 4. Shared-index / `git worktree` plumbing side-effects — RULED OUT

`git worktree add`/`remove`/`prune` and the `reap` subcommand
([`worktree-guard`](../../packages/pipeline-cli/src/tools/worktree-guard/command.ts)) operate on
per-worktree metadata and the worktree's own tree; none stage into the primary index. The `reap`
path runs `git worktree remove` **without `--force`** (it refuses on a dirty tree), so it cannot mass-
delete-and-stage. No shared-index interaction stages the primary.

## Root-cause finding (narrowed, with evidence)

The 248 staged deletions were an **unscoped `git add` / `git rm --cached`-class command executed
against the PRIMARY index by an actor NOT covered by the `pinBash` cwd-pin** — narrowed to two
indistinguishable-by-state candidates, in likelihood order:

1. **The primary operator/orchestrator session (top suspect).** `pinBash` is a deliberate no-op
   there, so this surface is unguarded in *every* regime. Any unscoped staging command run in that
   session lands on the primary index.
2. **A worktree agent whose pre-bash hook was inactive that session** (plugin not enabled/installed
   at spawn), with a cwd reset to primary and a bare staging command. With the hook **active**, this
   is contained to the worktree, so this candidate requires an inactive-hook session.

Vectors 1 and 4 (hooks, worktree plumbing) are ruled out as stagers; vector 2 is contained *iff the
hook was active*. Because staging leaves no reflog trace, the two surviving candidates cannot be
separated from the post-hoc index state — **which is precisely what the instrumentation below exists
to resolve on the next occurrence.**

## Why main-sync caught it, and is it sufficient

### What caught it

`pipeline-cli main-sync`
([`packages/pipeline-cli/src/tools/main-sync/main-sync.ts`](../../packages/pipeline-cli/src/tools/main-sync/main-sync.ts))
surfaced the state via `decideMainRefresh`: on `main` with **tracked modifications**
(`hasTrackedModifications` — staged deletions are staged changes to tracked files), it returns
`leave-alone` with reason `dirty` and **refuses to fast-forward**, surfacing the dirt instead of
advancing. That fail-closed refusal is what stopped the sanctioned sync path and made the corruption
visible ("primary has diverged / dirty; resolve by hand").

Note the drain-sync half (`decideMainSync`) would *not* have caught it on its own: HEAD was on `main`
(0 commits ahead), so it returns `already-on-main` and does not consult dirt — it is
`decideMainRefresh`'s `hasTrackedModifications` gate specifically that surfaced the staged deletions.

### Is the guard sufficient? No — the catch was incidental.

- **It detects, it does not prevent.** main-sync only observes the *resulting* dirty state the next
  time the orchestrator runs it; it does nothing about the staging itself.
- **It only fires on the sanctioned path.** A blind hand-rolled `git commit` + `git push` from the
  primary **bypasses main-sync entirely**.
- **The deeper caller-agnostic guard does not cover this.** The `reference-transaction` `ref-guard`
  fires for every ref update regardless of caller — but it refuses only a **diverging** (non-fast-
  forward) `refs/heads/main` move. A commit of the 248 deletions **on top of** `origin/main` is a
  **fast-forward** of origin, so `ref-guard` **allows** it, and the subsequent push allows it. So
  nothing in the current stack would stop a primary `git commit` + `git push` from landing a 248-file
  control-plane deletion on `origin/main`.

**The residual blast-radius surface:** a direct primary commit + push that fast-forwards the mass
deletion onto `origin/main`. main-sync's dirty-check catches the *staged-but-uncommitted* state on
one path; once committed as a fast-forward, only the human-merge / branch-protection layer stands
between it and origin.

## The read-only instrumentation (this unit)

the `primary-index-guard` tool
([`packages/pipeline-cli/src/tools/primary-index-guard/`](../../packages/pipeline-cli/src/tools/primary-index-guard/)) — a pure, unit-tested
detection core plus a thin Effect CLI that, at commit time, records (never blocks) an **attribution
event** when the staged index carries the #2778 signature (a mass control-plane staged deletion),
capturing `CLAUDE_CODE_AGENT` / `CLAUDE_CODE_SESSION_ID` / cwd / primary-vs-worktree. It is wired as a
read-only, fail-open `pre-commit` leg in [`lefthook.yml`](../../lefthook.yml).

Why `pre-commit`: it is the one **caller-agnostic** choke point git itself fires — it captures the
primary operator session (the top suspect, invisible to the `PreToolUse` Bash hook) *and* any worktree
agent, at the exact moment before the blast (commit → push). It attributes the **actor committing the
corrupted index**; the full *staging-command* attribution (which `git add`/`rm` ran, with its cwd)
requires wiring into the `PreToolUse` Bash hook, which is §CP — see the fix below.

Detection/attribution only: the recorder always exits 0, writes to an out-of-repo log, and mutates
nothing. It is a tripwire, not a gate.

## The §CP hardening fix (named, out of scope)

The fix is §CP (merge-by-hand): it touches `claude-plugins/kampus-pipeline/skills/write-code/**`,
`packages/pipeline-cli/**`, and/or `.claude/**` — all matching `CONTROL_PLANE_RE`. Recommended shape:

1. **Close the unguarded primary-operator surface.** Extend the caller-agnostic guard so a *staging*
   op that would delete the control-plane set from the primary index is refused (not just a diverging
   ref move) — i.e. a primary-index guard analogous to `ref-guard`, or promote the tripwire from
   record-only to block-on-primary. This is the real fix for the top suspect (vector 3).
2. **Wire the tripwire's attribution into the `PreToolUse` Bash hook** (`worktree-guard pre-bash`) so
   the *staging command + cwd + agent* is captured at the moment it runs, not just at commit — giving
   full attribution and closing the "was the hook active?" ambiguity of vector 2.
3. **Harden main-sync's containment into a guarantee** rather than an incidental catch — assert a
   clean primary index on the sync path and refuse a hand-rolled primary commit path that bypasses it.

## Same-vs-distinct vs #2666

**Distinct-but-related; keep both open, cross-linked — do not close/dup either** (a human merge call,
recorded here per the AC, not executed):

- **#2666** — inbound/milder: an *unauthored uncommitted hunk* appearing **inside** a fresh worktree
  (content bleeding INTO a worktree; benign, load-bearing on commit-by-explicit-path).
- **#2778** (this) — outbound/severe: mass *staged deletions* in the **primary** index (staging
  leaking OUT to the primary; blast radius = a control-plane mass-deletion push to `origin/main`).

Shared root family — **git state crossing checkout boundaries under worktree-isolated agents on a
shared `.git`** — but they differ in *direction* (into-worktree vs into-primary), *severity*, and
proximate mechanism (provisioning bleed vs an unscoped/unguarded staging op against the primary).
Neither subsumes the other. A single root-cause hardening ("worktree-isolated git ops crossing
checkout boundaries") may resolve both; consolidating them is a deliberate human merge, not an auto-
close. **Evidence for shared-root:** #2666's containment (`pinBash`'s stage-all refusal) and this
diagnosis both turn on the same `pinBash`/shared-`.git` seam; the divergence is only *which side* of
the checkout boundary the state crossed.
