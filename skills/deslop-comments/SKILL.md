---
name: deslop-comments
description: Ruthlessly cut the code comments that bury the code without earning their place — the AI-written wall a reader pattern-matches as boilerplate and skips. Use this WHENEVER the user complains that comments are useless, noisy, excessive, redundant, "slop", burying the code, or getting skipped over — even if they never name a skill or file — and after a large generated change leaves a wall of narration or docblocks. Also trigger on "/deslop-comments", "deslop comments", "cut/trim the comments", "remove slop comments", "decomment this/the codebase", "too many comments", "the comments are burying the code". NOT anti-comment — it keeps load-bearing notes, collapses duplicated "why" to ADR pointers, and migrates orphaned rationale into its real home (.decisions/.patterns) instead of deleting it. Scales to a whole-codebase pass in an isolated worktree across parallel agents.
---

# deslop-comments

A comment a reader pattern-matches as "AI boilerplate" and skips is worse than no comment: it adds visual noise that buries the code, and it rots silently because nobody reads it to notice it's wrong. This skill removes that class of comment. It is **not** anti-comment — a load-bearing note that tells the next agent something the code can't is the whole point of comments. The job is to widen the gap between those two.

## The one test

> **Would the next agent be wrong, slower, or surprised without this comment — in a way the code itself doesn't already tell them?**

If no → it's slop, cut it. If yes → keep it (and make sure it lives in the right place). "Required for the next agent" is the bar for any inline comment. Not every `if` block earns one.

## The doc taxonomy comes first

phoenix already has homes for the things big docblocks try to be (CLAUDE.md, "Doc surfaces"):

- **`.decisions/` (ADRs)** = the *why* + history, including superseded approaches.
- **`.patterns/`** = how the current code is *shaped* (evergreen).
- **`README`** = current state for builders.

An inline comment is the **surface of last resort** — for a load-bearing note that has *no other home* and belongs at this exact line. If a docblock is re-deriving a *why* that has (or deserves) an ADR, it is duplication, and duplication drifts. Shrink it to a pointer or migrate it.

## What to do, by category

**CUT (delete outright):**
- Separator / banner comments: `/* ---- Types ---- */`, `// ===== Helpers =====`.
- Comments that restate the symbol name or signature: `/** Title cap. */` over `POST_TITLE_MAX`, `/** The user id. */` over `userId: string`.
- Narration of obvious control flow: `// loop over posts`, `// return the result`, `// guard against null`.
- JSDoc that only mirrors param/return types with no added semantics.
- Commented-out code. (If it's a real "we might need this," it's an issue, not a corpse in the file — file it with `/report`.)
- Restatement of what an adjacent comment or the file header already said.

**COLLAPSE (shrink to a pointer):**
- A multi-paragraph docblock re-explaining a *why* that an ADR/pattern already owns → `// See ADR 0013` / `// keyset order: .patterns/fate-connections.md`. One line, pointing at the single source of truth.

**MIGRATE (extract, then pointer — see "Fork B" below):**
- A docblock carrying real load-bearing *why* with **no** home yet. Do **not** silently delete unhomed knowledge (CLAUDE.md: "don't leave a load-bearing pattern undocumented"). Extract it to a new ADR (`/adr`) or `.patterns/` doc, then replace the docblock with a pointer.

**KEEP (inline, as-is or trimmed):**
- A local invariant stated at its enforcement site ("`value` is `1 | null`; null retracts — up-only MVP").
- A workaround + the constraint that forces it ("CF isolates have no shutdown hook, so …").
- A `@ts-expect-error` / `// biome-ignore` rationale.
- A "looks wrong but is deliberate" guard that would otherwise get "fixed."
- A non-obvious gotcha the code can't express.

## Top-of-file docblocks

A header earns its place when it states **what the module is + the one non-obvious thing** about it, in a paragraph. It does *not* earn its place as a multi-section essay re-deriving the code below it — that's the wall. Trim headers to the what + the load-bearing why; push the rest into the categories above (collapse to ADR pointers, migrate orphans, cut narration).

## Hard nevers

- **Never touch code.** Comments only. The diff must be comments-and-whitespace.
- **Never delete `TODO` / `FIXME` / `HACK` markers.** If one is stale or actionable, file it with `/report` and remove it; otherwise leave it.
- **Never strip license headers, shebang lines, or tool pragmas** (`@ts-expect-error`, `biome-ignore`, `eslint-disable`, `@vitest-environment`).
- **Never invent an ADR number.** Read `.decisions/index.md` for the next monotonic number (the `/adr` skill does this).

## Running it at scale

For a whole-codebase pass, not a single file:

1. **Isolate.** Work in a per-run git worktree so nothing touches the user's tree *and* two concurrent decomment passes never collide on the branch or the dir — uniquify both with a per-invocation suffix: `SUF="$(date +%s)-$$"; git worktree add -b "umut/decomment-$SUF" "../phoenix-decomment-$SUF" main`. (A hardcoded `umut/decomment` / `../phoenix-decomment` makes the second run fail with `'umut/decomment' is already checked out` or clobber the shared dir.) Everything — this cleanup, plus any new ADR/pattern docs — lands on that one branch as one reviewable PR.
2. **Partition + fan out (phase 1, parallel).** Split the target files into disjoint groups (no two agents share a file) and spawn one agent per group. Subagents don't inherit skills — **paste the CUT/COLLAPSE/MIGRATE/KEEP rules into each agent's prompt, or have it Read this file.** Each phase-1 agent: CUTs, COLLAPSEs against *existing* ADRs/patterns, KEEPs — and for any **orphaned why** (migrate candidate with no home), it does **not** delete; it leaves the comment and appends an entry to an `ORPHANS.md` **at the root of this run's worktree** (`../phoenix-decomment-$SUF/ORPHANS.md`) — run-local because the worktree dir is per-run, so two concurrent passes never append to the same file: file path + 1-line summary of the homeless knowledge. This keeps phase 1 safe to parallelize.
3. **Migrate (phase 2, serial).** Review this run's `ORPHANS.md`. Creating ADRs concurrently collides on numbering, so do this in one thread: for each real orphan, `/adr` (or write a `.patterns/` doc), then replace the inline docblock with a pointer. Drop orphans that turn out to be slop after all.
4. **Verify.** `pnpm typecheck` (comments-only should be a no-op, but JSDoc removal near `@ts-expect-error` can shift), then `pnpm format` to restore tabs/100-col. Report a `git diff --stat` for review — never auto-merge.

Scale the agent count to the file count; chunk large restructures into more, smaller agents (the runtime kills a process after ~600s of no progress).
