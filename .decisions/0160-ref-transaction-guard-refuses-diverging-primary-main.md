---
id: 0160
title: "A git reference-transaction guard refuses a diverging refs/heads/main ref-move on the shared primary checkout — caller-agnostic and fail-closed, where the #1571 PreToolUse Bash hook cannot reach"
status: accepted
date: 2026-07-05
tags: [pipeline, git, worktree, primary-checkout, gates, control-plane]
---

## Context

The shared primary checkout's `main` **branch ref** was force-moved off the merge seam by
the orchestrator/PULLER role and left **diverged** from `origin/main` — a bare
`git branch -f main` / `checkout -B main` / `update-ref refs/heads/main` that landed `main`
on a stranding commit with a ~13.5k-line deletion staged (#2143). That is a "one
`git push -f` clobbers `origin/main`" loaded gun, and it silently blocked a founder-side
prod op until the checkout was repaired (preserve-then-reset).

The existing guard — the #1571 `worktree-guard` bash-pin
(`packages/pipeline-cli/src/tools/worktree-guard/bash-pin.ts`) — does **not** cover this class,
on three counts:

1. **Wrong arming condition.** It arms only when `$WORKTREE_ROOT` names a managed worktree
   (an `isolation:worktree` subagent). The offender is the orchestrator/PULLER running bare
   git in the primary checkout, which carries no `$WORKTREE_ROOT` — its own docblock states
   that flow "can never reach this refusal."
2. **Wrong op set.** Its `HEAD_MOVING` set is `{checkout, switch, reset, rebase, stash, merge}`
   — a ref force-move (`branch -f` / `update-ref` / `push HEAD:main`) is not in it. A diverging
   ref-move is a worse failure than the detached-HEAD case #1571/#1494 targeted.
3. **Wrong boundary.** The forensics place the literal keystroke **outside the agent Bash
   tool-call path** entirely (candidates: harness worktree machinery, a manually-run
   `pipeline-cli main-sync --execute`, or a git hook). A `PreToolUse` Bash hook cannot
   intercept a ref-move it never sees.

The coders were clean (they ran only `git -C "$WT"` inside worktrees; the full ref-force-move
class was grepped across all subagent Bash calls with zero hits). This is **not** a
worktree-isolation gap (ADR 0109 held). It is a hole in *who* can move the primary's `main`
ref and *where* that move is checked.

## Decision

Add a **caller-agnostic, fail-closed guardrail at git's own `reference-transaction`
boundary** that **refuses any `refs/heads/main` update on the shared primary checkout that
would make local `main` a non-fast-forward of `origin/main`.**

- **Boundary.** Git's `reference-transaction` hook fires for **every** ref update regardless
  of who initiates it — agent Bash, harness worktree machinery, a manually-run command, or
  another git hook. This is the reach a `PreToolUse` Bash hook structurally lacks, and it is
  the exact requirement the #2143 forensics impose (the keystroke was outside the agent
  path). The hook runs on `prepared` | `committed` | `aborted` and receives one
  `<old> <new> <ref>` line per queued update on stdin; git honors a non-zero exit **only in
  `prepared`**, aborting the whole transaction — so the guard evaluates and can refuse only
  there.

- **Shape (mirror the `main-sync` / `bash-pin` pure-core-plus-thin-boundary idiom).** A pure,
  unit-tested decision core `decideRefUpdate`
  (`packages/pipeline-cli/src/tools/ref-guard/ref-guard.ts`) — IO-free, total over a queued
  ref update × the origin ancestry fact — and a thin git boundary `command.ts` that reads
  stdin, resolves `origin/main`, and runs `git merge-base --is-ancestor origin/main <newOid>`.
  Wired as `pipeline-cli ref-guard reference-transaction <state>` and installed via
  `lefthook.yml` (ADR 0068) into the shared `.git/hooks`.

- **The decision (the whole safety property).** On `refs/heads/main`: allow only a
  fast-forward of `origin/main` (`origin/main` an ancestor of the new tip, or new tip ==
  `origin/main`); refuse a non-fast-forward **divergence**, and refuse a delete. Every other
  ref (feature branches, tags, `origin/*`) is out of scope and passes untouched — so a
  worktree agent moving its own branch ref never reaches the guarded path. The legitimate
  PULLER flow passes by construction: `merge --ff-only origin/main` is a fast-forward, and the
  reattach `checkout main` moves no ref on `main` at all.

- **Fail-open on infra absence, fail-closed on divergence.** An unresolvable `origin/main`
  (a fresh clone before the first fetch) allows the update — there is nothing to diverge from,
  and the divergence the guard exists to catch is undefined without an origin. But an ancestry
  probe that *fails* is treated as non-ff and refuses on the guarded ref (cannot prove a
  fast-forward ⇒ divergence). The guard signals a deliberate refuse with a **dedicated exit
  code (3)**, distinct from success (0) and any infrastructural failure (1 / 127); the
  `lefthook.yml` wrapper aborts the transaction **only** on code 3 and fail-opens on every
  other non-zero. This preserves the #1050 / #787 fail-open invariant: a not-yet-installed or
  stripped-PATH CLI — or `bin.ts`'s unlinked-dependency remediation, which itself exits 1
  (#1798) — must never wedge every ref transaction repo-wide.

- **ROE (AC #4).** The PULLER/orchestrator drives sync **only** through the
  fetch-inspect-`ff-only` seam (`pipeline-cli main-sync`, #1573) — never a bare
  `checkout -B main` / `branch -f main` / `reset` / `update-ref refs/heads/main` on the
  primary. This ADR + the `ref-guard` hook **are** the durable enforcement of that rule, so it
  no longer lives only in operator memory.

## Consequences

- The #2143 class is now structurally unreachable: any diverging `refs/heads/main` move on the
  shared primary aborts at the ref boundary before it lands, whoever attempts it and however
  it is invoked. The loaded gun cannot be loaded.
- It is **control-plane** (ADR 0135): it touches `packages/pipeline-cli/**` and `lefthook.yml`
  (git-hook install), so its PR is human-merge-only (cansirin), never auto-shipped.
- The guard is scoped tightly — only `refs/heads/main`, only a non-fast-forward — so it never
  interferes with worktree branch pushes, tag moves, or `origin/*` fetches, and never with the
  legitimate `merge --ff-only` sync.
- It is the **ref-force-move / divergence** sibling of two adjacent primary-checkout defects:
  the detached-HEAD lineage (#1103 / #1494 / #1571 / #2030 → `main-sync` and the bash-pin) and
  the silent-drift side (#2056, still open). All three are primary-checkout safety holes; this
  ADR closes the force-move one and leaves the others distinct.
- Because it lives in the shared `.git/hooks` (via lefthook), a worktree consuming those hooks
  also runs it — harmless, since a worktree never moves `refs/heads/main` (it works on its own
  branch), so the guard is a no-op for it.

### Coverage boundary (stated honestly, not oversold)

`reference-transaction` fires on every git **ref transaction** — `update-ref`, `checkout -B`,
`reset`, `branch -f`, a push that updates a local ref, and the `branch: Reset to HEAD`
transaction that stranded us. It does **not** intercept a **raw filesystem write** to
`.git/refs/heads/main` (or a `.git/packed-refs` edit) that bypasses git's ref machinery
entirely — that is an exotic path, not the #2143 incident (which was a real git ref
transaction), and git itself offers no hook for it. So the guard's claim is precisely "any
diverging `refs/heads/main` move performed **through git**, by any caller," not "any possible
mutation of the ref bytes." The proof is a test that installs the hook and drives a **bare
`git update-ref refs/heads/main`** with no pipeline command in the loop — it aborts, which is
the acceptance bar; a CLI you must invoke could not guard a move that bypasses the CLI, which
is exactly why the boundary is the hook, not a command.

One operational caveat: a git hook fires only where `.git/hooks/reference-transaction` is
installed. The primary checkout and its linked worktrees share one `.git`, so `lefthook
install` (run once from the primary, ADR 0109 / #1243) arms it for all of them; a
freshly-cloned checkout that has not yet run `lefthook install` is unguarded until it does —
the same install-dependency every lefthook-managed hook (the `pre-commit` leak-guard) already
carries, and CI remains the unbypassable backstop for what CI gates.
