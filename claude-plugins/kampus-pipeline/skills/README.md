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
report → triage → plan-epic → review-plan → write-code → review-code / review-doc / review-skill → ship-it
```

- **`report`** files raw intake (`status:needs-triage`).
- **`triage`** classifies, prioritizes, and either splits an epic or marks an issue
  `status:triaged` (pickable).
- **`plan-epic`** turns a triaged epic into a child-issue ledger with a `## Dependencies`
  topology; **`review-plan`** gates that ledger and flips its children to `status:triaged`.
- **`write-code`** picks the next triaged issue, implements it on a branch, and opens a PR.
- **`review-code`** (code PRs) / **`review-doc`** (doc PRs) / **`review-skill`** (skill PRs)
  verify the PR against its issue's acceptance criteria — `review-doc` adds a doc-hygiene
  checklist, `review-skill` adds a behavioral-rigor checklist — and emit a PASS/FAIL verdict;
  `write-code` consumes a FAIL and re-submits; the loop is bounded. The three split on
  artifact class (code / docs / skills — ADR 0073, superseding 0063's `skills/**` →
  `review-code` routing).
- **`ship-it`** is the only skill with merge authority: on a PASS verdict + green CI it
  squash-merges, closing the linked issue.

Three skills run **standalone**, outside the linear flow:

- **`heal-ci`** triages a red CI run (flake vs. defect) and routes it.
- **`adr`** records an architecture decision into `.decisions/`.
- **`deslop-comments`** strips noise comments from the working tree.

## The 13 skills

| Skill | One-line |
|-------|----------|
| `report` | File a follow-up GitHub issue the moment you spot tangential work — a bug, refactor, design question, missing test — as type-blind `status:needs-triage` intake. |
| `triage` | Process the triage queue: classify, enrich, prioritize, split, or close `status:needs-triage` issues — the guardrail between raw intake and pickable work. |
| `plan-epic` | Turn a triaged epic into a PRD-grade task ledger of tracer-bullet sub-issues, each tracing to a user story, with a pinned `## Dependencies` topology. |
| `review-plan` | Gate a planned epic's ledger against the deterministic structural floor, flipping `status:planned → status:triaged` on a clean ledger (the plan-layer gate). |
| `write-code` | Pick the next triaged issue, claim it, implement on a branch, open a PR that closes it — or, given a PR number, repair a gate's FAIL on the same branch. |
| `review-code` | Verify a code PR against its linked issue's acceptance criteria, one criterion at a time, evidence-based — a fresh-eyes QA gate that never self-merges. |
| `review-doc` | The doc-artifact twin of `review-code`: verify a `.decisions`/`.patterns`/prose PR against its criteria plus a doc-hygiene checklist. |
| `review-skill` | The behavioral-artifact sibling: verify a `skills/**` PR against its criteria plus a rigor checklist (behavioral correctness, trigger quality, cross-skill shadowing, gate-invariant preservation); config-pinned to the base (ADR 0073). |
| `ship-it` | The terminal stage: on a PASS verdict + green CI, squash-merge one PR and confirm the issue auto-closed — the only skill with merge authority. |
| `heal-ci` | Classify a red CI run into flake-vs-defect and emit one routed action — rerun a known transient once, or file a defect via `report`. |
| `adr` | Record an architecture decision (Context / Decision / Consequences) into `.decisions/NNNN-slug.md` and the index, following supersede rules. |
| `deslop-comments` | Ruthlessly cut comments that bury the code without earning their place — keeping load-bearing notes, collapsing duplicated "why" to ADR pointers. |
| `doctor` | Preflight a repo against the pipeline prerequisites (gh auth + scope, the 15 required labels, repo resolution, a CI signal, npm deps) and print a tiered pass/fail checklist with the exact fix command for each gap. |

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

**All 11 skills are fully repo-agnostic** — they carry no repo literals beyond the
resolved `$REPO`, so they operate on your repo out of the box.

This includes **`review-plan`**, which is now **portable** too. Its deterministic ledger
gate resolves **in-repo first, published fallback** (ADR
[0064](https://github.com/kamp-us/phoenix/blob/main/.decisions/0064-epic-ledger-npm-publish-automated-release.md)):
phoenix runs the on-disk `packages/epic-ledger` bin, and a foreign install runs the
**published** [`@kampus/epic-ledger`](https://www.npmjs.com/package/@kampus/epic-ledger)
CLI via `pnpm dlx` — so a non-phoenix install **runs** the gate (validates the ledger,
flips `status:planned → status:triaged` on a clean one, posts a per-defect FAIL on a dirty
one) instead of degrading. The published package resolves its target repo from
`CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`, fail-closed (#408). This
closed the last `10/11 → 11/11` gap — the follow-up epic
[#362](https://github.com/kamp-us/phoenix/issues/362) that ADR 0062 §3 deferred — and was
proven end-to-end against a real foreign repo (#368).

The **`adr`** skill is portable on the same shape. Its index-regeneration step (which
rewrites `.decisions/index.md` from each ADR's front-matter, ADR
[0066](https://github.com/kamp-us/phoenix/blob/main/.decisions/0066-generate-decisions-index.md))
resolves **in-repo first, published fallback**: phoenix runs the on-disk
`packages/decisions-index` bin, and a foreign install runs the published
[`@kampus/decisions-index`](https://www.npmjs.com/package/@kampus/decisions-index) CLI via
`pnpm dlx @kampus/decisions-index@latest generate`. This closed the
[#423](https://github.com/kamp-us/phoenix/issues/423) caveat (the regen previously shelled
out to a workspace-only `pnpm --filter`, which silently no-ops outside phoenix). The CLI
operates on the local `.decisions/` tree, so it needs no repo resolution. Validated
end-to-end in a real non-phoenix repo (#432): `generate` regenerated a correct index and
`check` gated a stale one — no `--filter` no-op, no `ERR_MODULE_NOT_FOUND`.

### Validating portability in a foreign repo

**Start with `doctor`.** Before the first run in a freshly-adopted repo, run the `doctor`
skill (`.claude/skills/doctor/doctor.sh`) — it asserts the prerequisites in one pass (gh
auth + the `project` scope, the 15 required `status:*`/`type:*`/`p*` labels, repo
resolution, a CI signal, and the `@kampus/*` npm deps) and prints a tiered pass/fail
checklist with the exact `gh label create …` / `gh auth refresh …` fix command for each
gap. It turns "did I wire this up right?" into one checkable command instead of a first run
that fails deep inside a `gh api` call.

To re-prove a skill's published fallback runs outside phoenix (the repeatable procedure
behind #368 / #432), exercise it in a throwaway non-phoenix git repo — **not** phoenix
itself (the install-into-self caveat, §5 below, means phoenix doesn't count):

1. `mkdir` a scratch dir outside phoenix, `git init`, and create the inputs the skill
   consumes — e.g. for `adr`, a `.decisions/` with 2–3 ADR files carrying `id`/`title`/
   `status`/`date` front-matter (optionally a deliberately-stale `index.md` to prove
   regeneration overwrites it). Confirm no `@kampus/*` workspace package is present, so the
   published-fallback path is what runs.
2. Run the exact published-fallback command the skill uses (`adr`:
   `pnpm dlx @kampus/decisions-index@latest generate`) from the scratch repo root.
3. Confirm a correct artifact is produced (`index.md` with one row per ADR, ordered by
   `id`, derived verbatim from front-matter) — not a `pnpm --filter` no-op and not an
   `ERR_MODULE_NOT_FOUND` / "matches nothing" failure.
4. Run the gate (`pnpm dlx @kampus/decisions-index@latest check`): exit `0` on the fresh
   index, then mutate an ADR and re-run to confirm it exits non-zero — proving the gate
   works in a foreign checkout.

Capture the command output + the before/after artifact in the validating issue's progress
comment as the durable evidence.

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

### Layout: a multi-plugin marketplace, each plugin in its own subdir

The repo is a **proper marketplace** that can host many plugins. `claude-plugins/` is the
**container**; each plugin gets its own subdirectory (`claude-plugins/<plugin>/`) holding
its `.claude-plugin/plugin.json` + `skills/`. Today that's `claude-plugins/kampus-pipeline/`;
a second plugin is just a sibling `claude-plugins/<other>/` plus one more entry in the
catalog. Each plugin's source (`source: "./claude-plugins/<plugin>"`) distributes **only that
subtree** — the packaging fix from ADR [0087](https://github.com/kamp-us/phoenix/blob/main/.decisions/0087-plugin-dedicated-subdir-source.md): a `"./"` source copies the **whole monorepo**
into every install (Claude Code does a full recursive copy and honors no ignore mechanism),
so a plugin must be the only thing under its source root.

Claude Code's **plugin** discovery scans the plugin source root's `skills/` directory and
offers no manifest field to redirect it. Phoenix's **local** discovery reads
`.claude/skills/`. To satisfy both with **no duplicated content**:

- **Canonical files live at `claude-plugins/kampus-pipeline/skills/`** — the plugin source-root location.
- **`.claude/skills` is a symlink → `../claude-plugins/kampus-pipeline/skills`** (relative target, stored
  in git as a mode-`120000` symlink blob). Local discovery follows it to that directory.

Editing a file in one location is editing it in the other — there is exactly one source of
truth. The relative symlink target means it **resolves in a fresh `git clone`** (marketplace
installs clone the repo), not only in the working tree. CI runs the validators through the
same symlink (`bash .claude/skills/validate-skills.sh`), so the layout needs no workflow change.

```
phoenix/
├── .claude-plugin/
│   └── marketplace.json                 # catalog — lists each plugin + its source
├── claude-plugins/                      # marketplace container (one subdir per plugin)
│   └── kampus-pipeline/                 # this plugin — source: "./claude-plugins/kampus-pipeline"
│       ├── .claude-plugin/
│       │   └── plugin.json
│       └── skills/                      # canonical — plugin source-root discovery
│           ├── <name>/SKILL.md
│           └── gh-issue-intake-formats.md
├── apps/  packages/  infra/             # repo source — no longer shipped to installers
└── .claude/
    └── skills -> ../claude-plugins/kampus-pipeline/skills  # symlink — local discovery
```

#### Link invariants

- **Intra-suite links stay relative and travel inside the plugin's `skills/`**: each `SKILL.md`'s
  `../gh-issue-intake-formats.md` and `../<sibling>/SKILL.md` resolve against this tree
  regardless of which discovery path reached them.
- **External doc-references** (`.decisions/*`, `.patterns/*`, `CLAUDE.md`) are
  phoenix-specific rationale and are written as **stable GitHub permalinks**, not relative
  paths (ADR 0062 §4) — so they resolve from an adopter's install, where those trees don't
  exist.

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
