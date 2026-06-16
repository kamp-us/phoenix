# kampus-pipeline — the agent-operable GitHub issue pipeline

`kampus-pipeline` is a Claude Code plugin: a suite of skills that turns a GitHub
repo's issue queue into an **agent-operable pipeline**. A report becomes a triaged,
prioritized issue; an epic becomes a planned, dependency-ordered ledger; a triaged
issue becomes a branch, a PR, and a verified merge — each stage a skill an agent runs,
each handoff a durable artifact (a label, a comment, a PR) the next stage reads cold.
The suite is **repo-agnostic**: install it once and point it at whatever repo you're
working in.

This directory (`skills/`) is the **canonical home** for the suite and the plugin's
documented entry point. It holds every `SKILL.md` plus the shared contract doc
[`gh-issue-intake-formats.md`](gh-issue-intake-formats.md) (the label semantics and the
body/comment/dependency formats every skill reads and writes).

**Plugin version: `0.1.0`** (see [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json)).

## The pipeline

The core flow runs left to right; each stage consumes the previous stage's output:

```
report → triage → plan-epic → review-plan → write-code → review-code / review-doc → ship-it
```

- **`report`** files raw intake (`status:needs-triage`).
- **`triage`** classifies, prioritizes, and either splits an epic or marks an issue
  `status:triaged` (pickable).
- **`plan-epic`** turns a triaged epic into a child-issue ledger with a `## Dependencies`
  topology; **`review-plan`** gates that ledger and flips its children to `status:triaged`.
- **`write-code`** picks the next triaged issue, implements it on a branch, and opens a PR.
- **`review-code`** (code PRs) / **`review-doc`** (doc PRs) verify the PR against its
  issue's acceptance criteria and emit a PASS/FAIL verdict — `write-code` consumes a FAIL
  and re-submits; the loop is bounded.
- **`ship-it`** is the only skill with merge authority: on a PASS verdict + green CI it
  squash-merges, closing the linked issue.

Three skills run **standalone**, outside the linear flow:

- **`heal-ci`** triages a red CI run (flake vs. defect) and routes it.
- **`adr`** records an architecture decision into `.decisions/`.
- **`deslop-comments`** strips noise comments from the working tree.

## The 11 skills

| Skill | One-line |
|-------|----------|
| `report` | File a follow-up GitHub issue the moment you spot tangential work — a bug, refactor, design question, missing test — as type-blind `status:needs-triage` intake. |
| `triage` | Process the triage queue: classify, enrich, prioritize, split, or close `status:needs-triage` issues — the guardrail between raw intake and pickable work. |
| `plan-epic` | Turn a triaged epic into a PRD-grade task ledger of tracer-bullet sub-issues, each tracing to a user story, with a pinned `## Dependencies` topology. |
| `review-plan` | Gate a planned epic's ledger against the deterministic structural floor, flipping `status:planned → status:triaged` on a clean ledger (the plan-layer gate). |
| `write-code` | Pick the next triaged issue, claim it, implement on a branch, open a PR that closes it — or, given a PR number, repair a gate's FAIL on the same branch. |
| `review-code` | Verify a code PR against its linked issue's acceptance criteria, one criterion at a time, evidence-based — a fresh-eyes QA gate that never self-merges. |
| `review-doc` | The doc-artifact twin of `review-code`: verify a `.decisions`/`.patterns`/prose PR against its criteria plus a doc-hygiene checklist. |
| `ship-it` | The terminal stage: on a PASS verdict + green CI, squash-merge one PR and confirm the issue auto-closed — the only skill with merge authority. |
| `heal-ci` | Classify a red CI run into flake-vs-defect and emit one routed action — rerun a known transient once, or file a defect via `report`. |
| `adr` | Record an architecture decision (Context / Decision / Consequences) into `.decisions/NNNN-slug.md` and the index, following supersede rules. |
| `deslop-comments` | Ruthlessly cut comments that bury the code without earning their place — keeping load-bearing notes, collapsing duplicated "why" to ADR pointers. |

## Install

The suite is distributed through the **`kampus`** self-hosted marketplace. From within
Claude Code:

```
/plugin marketplace add kamp-us/phoenix
/plugin install kampus-pipeline@kampus
```

`kamp-us/phoenix` is the marketplace repository; `kampus-pipeline@kampus` is the plugin
`kampus-pipeline` from the `kampus` marketplace. After install, the 11 skills are
available in the picker (e.g. `triage`, `write-code`, `ship-it`).

## Configuration — point the pipeline at your repo

The pipeline is **zero-config for the common case**. Every skill resolves its target
repo (the repo whose issues/PRs it operates on) in this order (ADR 0062 §1):

1. **`$CLAUDE_PIPELINE_REPO`** if set, in `owner/repo` form — the explicit override.
2. Otherwise **the current git repository** (`gh repo view`, which reads the `origin` remote).

```bash
# the one resolution every parameterized skill uses
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

So if you run the skills from inside a clone of your repo, the pipeline operates on that
repo with **no configuration**. Set `CLAUDE_PIPELINE_REPO=owner/repo` only for the
off-cases — a fork workflow, or when the working directory's `origin` isn't the repo you
mean to operate on. (Be aware: a stale `CLAUDE_PIPELINE_REPO` will silently operate on
the wrong repo — the default-to-current-repo path is the safe one; the override is opt-in.)

The skills use the [GitHub CLI (`gh`)](https://cli.github.com/) for all reads and writes,
so a logged-in `gh` is the only prerequisite.

## Portability boundary (ADR 0062)

**10 of the 11 skills are fully repo-agnostic** — they carry no repo literals beyond the
resolved `$REPO`, so they operate on your repo out of the box.

The one exception is **`review-plan`**, which is **phoenix-pinned for v1**. Its
deterministic ledger gate runs the in-repo `@phoenix/epic-ledger` package, which is not
bundled into the plugin. In a non-phoenix repo `review-plan` **degrades gracefully** —
it prints `review-plan requires @phoenix/epic-ledger (not available in this install — see
ADR 0062 §3)` rather than a raw crash. The other 10 skills, including the rest of the
plan→build→ship loop, work without it. (Publishing `@phoenix/epic-ledger` so `review-plan`
becomes portable is a deferred follow-up — ADR 0062 §3.)

Two more boundary notes:

- **External doc references** in the skills (to phoenix's `.decisions/`, `.patterns/`,
  `CLAUDE.md`) are rewritten to **stable phoenix GitHub permalinks** — they are
  phoenix-specific rationale, not bundled into your repo (ADR 0062 §4). Intra-suite links
  stay relative and travel inside `skills/`.
- **Don't install the plugin into phoenix itself** (ADR 0062 §5). Phoenix already carries
  the canonical suite via local discovery (see below); installing the plugin on top would
  double every skill in the picker. The plugin exists for *other* repos.

---

## For phoenix maintainers: layout and discovery

The sections below are phoenix-internal — they explain how the one source of truth serves
both plugin and local discovery. Adopters can stop reading here.

### Layout: one canonical home, bridged by a clone-safe symlink

Claude Code's **plugin** discovery scans only a plugin-root `skills/` directory and
offers no manifest field to redirect it. Phoenix's **local** discovery reads
`.claude/skills/`. To satisfy both with **no duplicated content**:

- **Canonical files live here, at repo-root `skills/`** — the plugin-root location.
- **`.claude/skills` is a symlink → `../skills`** (relative target, stored in git as a
  mode-`120000` symlink blob). Local discovery follows it to this directory.

Editing a file in one location is editing it in the other — there is exactly one source
of truth. The relative symlink target (`../skills`) means it **resolves in a fresh
`git clone`** (marketplace installs clone the repo), not only in the working tree.

```
phoenix/
├── skills/                 # canonical — plugin-root discovery location
│   ├── <name>/SKILL.md
│   └── gh-issue-intake-formats.md
└── .claude/
    └── skills -> ../skills # symlink — local .claude/skills/ discovery
```

#### Link invariants

- **Intra-suite links stay relative and travel inside `skills/`**: each `SKILL.md`'s
  `../gh-issue-intake-formats.md` and `../<sibling>/SKILL.md` resolve against this tree
  regardless of which discovery path reached them.
- **External doc-references** (`../../../.decisions/*`, `.patterns/*`, `CLAUDE.md`) are
  phoenix-specific rationale and are rewritten to stable GitHub URLs separately (see ADR
  0062 §4); they are not bundled into an adopter's repo.

### In-repo discovery doubling — accept the doubles (ADR 0062 §5)

When the plugin is installed at **user scope** and a maintainer works **inside phoenix**,
every skill surfaces twice in the picker: bare `report` (project-scope `.claude/skills/`)
and `phoenix:report` (plugin scope). Claude Code does not dedupe skill names across scopes
and has no per-project plugin disable (upstream anthropics/claude-code#53923).

**Disposition: accept the doubles for v1.** The recommendation is that **phoenix
maintainers rely on the local `.claude/skills/` discovery and do _not_ install the plugin
into phoenix itself** — they already have the canonical suite locally; the plugin exists
for *other* repos. This is a documentation cost, not a functional one. Revisit if/when
upstream ships a per-project plugin toggle. See ADR 0062 §5 for the full rationale.
