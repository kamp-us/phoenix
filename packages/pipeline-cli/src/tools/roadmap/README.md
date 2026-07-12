# roadmap — the read-only roadmap view

`pipeline-cli roadmap view [--root <dir>]`

The **observability surface** of the steering seam (roadmap map #2620; part 3 of the three-part
seam settled in #2639 — parts 1–2 are the active-milestone grounding + the arc-flip re-triage
sweep, tracked separately). It renders the roadmap work-tree top-down and flags the drift a puller
cares about, so the founder can see "the tree + what agents are building on it right now" with one
command.

## What it renders

```
Roadmap — active arc: Four Pillars (milestone #17)

Arcs:
▸ Four Pillars [active] → milestone #17 "…" [open]  ← ACTIVE ARC
    ◆ epic #123 [open] p1 …
        · #124 [open] …
        · #125 [closed] …
    · #130 [open] …            (loose, non-epic issue)
    PRs:
        ⇢ PR #200 build … → #124
▸ Geçit [queued] → milestone #24 "…" [open]
    (no open work)

Campaigns:
▸ Mentor Audit [active] → milestone #27 "…" [open]
    …

⚠ Drift: 2 stale p1(s) — open p1 outside the active-arc milestone #17 (…):
    #140 … (milestone #24)
    #141 … (no milestone)
```

The hierarchy is **arcs → milestones → epic trees → open PRs**, driven by:

- **ROADMAP.md's `## Arcs` / `## Campaigns` tables** — the sole parsed roadmap surface (#2630/#2632).
  The table parse is reused from `roadmap-guard` so the view and the guard agree on the grammar by
  construction. The active-arc row (`state = active`) is the source of truth for the stale-p1 check.
- **Live GitHub state via `gh api` REST** — milestones, open issues (+ each epic's sub-issue
  children), and open PRs. Never GraphQL (the org's legacy Projects-classic integration errors
  GraphQL issue/PR queries).

## Drift: stale p1s

The one flagged drift is **stale p1s** — open `p1` issues sitting *outside* the active-arc
milestone. These are the issues a puller would keep draining after an arc flip if the lever were
decorative; surfacing them is the point of the view (#2639). With no single resolvable active arc,
every open p1 is flagged (fail-loud).

## Read-only

The command **mutates nothing** — no labels, no milestones, no issue/PR writes. Every `gh api` call
is a GET. It is a *render*, not a guard: `roadmap-guard` (#2632) owns the fail-closed ROADMAP.md ↔
milestone sync enforcement; this view owns human-legible display. They are separate tools.

## Shape

The pipeline-cli view idiom (the `decisions-index compact` / `roadmap-guard` house style): a pure,
IO-free, unit-tested core (`roadmap.ts` — the table join, the tree assembly, the stale-p1
derivation, the render) plus a thin `gh api` boundary (`github.ts`) and IO seam (`view.ts`). The
core is tested exhaustively over fixtures without spawning `gh` (`roadmap.unit.test.ts`). The
target repo resolves per ADR 0062 §1: `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`.

## §CP

This lands under `/packages/pipeline-cli/`, a control-plane surface per CODEOWNERS
(`/packages/pipeline-cli/ @kamp-us/control-plane`, ADR 0100). Read-only-ness does not exempt it —
§CP is a path-based code-owner gate, so any PR touching this path merges via the §CP review path.
