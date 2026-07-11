# kampus-pipeline — the agent-operable GitHub issue pipeline

`kampus-pipeline` is a Claude Code plugin: a suite of skills that turns a GitHub
repo's issue queue into an **agent-operable pipeline**. A report becomes a triaged,
prioritized issue; an epic becomes a planned, dependency-ordered ledger; a triaged
issue becomes a branch, a PR, and a verified merge — each stage a skill an agent runs,
each handoff a durable artifact (a label, a comment, a PR) the next stage reads cold.
The suite is **repo-agnostic**: install it once and point it at whatever repo you're
working in.

**This plugin is the entry point.** You are reading its root README — the front door.
The skills themselves live one level down in [`skills/`](skills/) (every `SKILL.md` plus
the shared contract doc [`gh-issue-intake-formats.md`](skills/gh-issue-intake-formats.md),
which defines the label semantics and the body/comment/dependency formats every skill
reads and writes). You don't invoke those files directly — you install the plugin and run
the skills by name (`report`, `triage`, `write-code`, …). The [How the pipeline works](#how-the-pipeline-works)
section below is the fastest way to understand the whole flow before you touch a skill.

## How the pipeline works

If you're new here, read this section first. The pipeline is a **conveyor belt for issues**:
raw work enters at one end and a merged, closed PR comes out the other. Each stage is one
skill. A stage never keeps state in its head — it writes its output as a GitHub artifact (a
label, a comment, a PR) that the next stage picks up **cold**, so a fresh agent (or a
different one) can always continue where the last left off.

### The flow

The core flow runs left to right; each stage consumes the previous stage's output:

```
report → triage → plan-epic → review-plan → write-code → review-code / review-doc / review-skill → ship-it
```

### What each stage consumes and emits

| Stage | Consumes | Emits |
|-------|----------|-------|
| **`report`** | A raw observation (a bug, a refactor, a missing test) | A type-blind issue labelled `status:needs-triage` |
| **`triage`** | A `status:needs-triage` issue | Either a `status:triaged` issue (classified + prioritized, pickable) or an epic to be planned |
| **`plan-epic`** | A triaged epic | A ledger of child issues with a pinned `## Dependencies` topology (`status:planned`) |
| **`review-plan`** | A `status:planned` ledger | The same ledger gated against the structural floor; on a clean pass its children flip to `status:triaged` |
| **`write-code`** | The next `status:triaged` issue | A branch + a PR that closes it (`Fixes #N`); on a gate FAIL, a fix pushed to the same branch |
| **`review-code` / `review-doc` / `review-skill`** | An open PR + its issue's acceptance criteria | A SHA-bound `PASS`/`FAIL` verdict comment (the three split by artifact class: code / docs / skills) |
| **`ship-it`** | A PASS verdict + green CI | A squash-merge that closes the linked issue — the only stage with merge authority |

The split at the review step is by **artifact class**: `review-code` for code PRs,
`review-doc` for docs (`.decisions`/`.patterns`/prose), `review-skill` for `skills/**` PRs
(each adds a class-specific checklist). `write-code` consumes a FAIL and re-submits on the
same branch; the fix loop is bounded, and an independent reviewer — never the author —
re-gates each round (the split-role firewall: implementer ≠ reviewer).

### Three standalone skills (outside the linear flow)

- **`heal-ci`** triages a red CI run (flake vs. defect) and routes it.
- **`adr`** records an architecture decision into `.decisions/`.
- **`deslop-comments`** strips noise comments from the working tree.
- **`doctor`** preflights a repo against the pipeline's prerequisites and prints a pass/fail
  checklist with the exact fix command for each gap.

### One upstream skill (the ideation layer)

- **`wayfinder`** runs *before* triage: it charts a fuzzy destination into a living
  `wayfinder:map` issue and works its frontier of investigation/decision tickets until a
  concrete plan is ready to hand to `triage` / `plan-epic` — the pre-triage front door
  (epic #2421).

### How to kick it off

1. **Install the plugin** (see [Install](#install) below) and make sure `gh` is logged in —
   the only prerequisite.
2. **Run `doctor` once** in the target repo to confirm the prerequisites (gh auth + scope,
   the required labels, a CI signal). It turns "did I wire this up right?" into one command.
3. **Enter work through `report`** (or `wayfinder` for something still fuzzy). From there the
   pipeline pulls it forward: `triage` makes it pickable, `write-code` picks the next triaged
   issue and opens a PR, a review skill gates it, and `ship-it` merges on green.

You drive it stage by stage — each skill is a named action you invoke — and because every
handoff is a durable GitHub artifact, you can stop after any stage and resume later.

## The 14 skills

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
| `wayfinder` | The ideation-layer front door, upstream of the pipeline: chart a fuzzy destination into a living `wayfinder:map` issue, then work its open frontier of investigation/decision tickets — recording answers, graduating cleared fog, surfacing founder-decision-forks — until a concrete plan is ready for `triage` / `plan-epic` (epic #2421). |

## Install

The suite is distributed through the **`kampus`** self-hosted marketplace. From within
Claude Code:

```
/plugin marketplace add kamp-us/phoenix
/plugin install kampus-pipeline@kampus
```

`kamp-us/phoenix` is the marketplace repository; `kampus-pipeline@kampus` is the plugin
`kampus-pipeline` from the `kampus` marketplace. After install, the 14 skills are
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

## Design notes — versioning and spec conformance

The plugin carries **no per-plugin `version`** (neither in the marketplace plugin entry nor in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json)): Claude Code then content-addresses the install by git commit SHA, so every commit is a new "version" and skill additions/edits reach already-installed users on the normal update path — a fixed semver pin froze the cache and silently served stale content (#945). This omission is **deliberate, not a defect — do not add a `version`**; the decision record (why + history) is [ADR 0110](https://github.com/kamp-us/phoenix/blob/main/.decisions/0110-plugin-carries-no-version-continuous-ship.md).

The whole plugin surface was audited against the official Claude Code plugin spec ([plugins reference](https://docs.claude.com/en/docs/claude-code/plugins-reference), [marketplaces](https://docs.claude.com/en/docs/claude-code/plugin-marketplaces)); the conformance record — the corrected manifest `$schema` URL plus every deliberate deviation (no `version`, the root-level `hooks.json`, the absent `commands/`, the `.claude/skills` discovery symlink) and its forcing constraint — is [ADR 0171](https://github.com/kamp-us/phoenix/blob/main/.decisions/0171-kampus-pipeline-plugin-spec-conformance.md). A future audit that re-flags any of those reads the disposition there: documented-intentional, not an open defect.

## Portability boundary (ADR 0062)

**All 14 skills are fully repo-agnostic** — they carry no repo literals beyond the
resolved `$REPO`, so they operate on your repo out of the box.

This includes **`review-plan`**, which is now **portable** too. Its deterministic ledger
gate runs the **`pipeline-cli epic-ledger`** subcommand of the consolidated
`@kampus/pipeline-cli` (ADR
[0103](https://github.com/kamp-us/phoenix/blob/main/.decisions/0103-consolidate-pipeline-cli-package.md),
which supersedes the per-package publish + `pnpm dlx` fallback of ADR
[0064](https://github.com/kamp-us/phoenix/blob/main/.decisions/0064-epic-ledger-npm-publish-automated-release.md)):
a `SessionStart` hook installs `@kampus/pipeline-cli` once into `${CLAUDE_PLUGIN_DATA}`, and
both phoenix and a foreign install invoke the **same** `pipeline-cli epic-ledger` — so a
non-phoenix install **runs** the gate (validates the ledger, flips `status:planned →
status:triaged` on a clean one, posts a per-defect FAIL on a dirty one) instead of degrading.
The CLI resolves its target repo from `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo
view`, fail-closed (#408). This closed the last portability gap — the follow-up epic
[#362](https://github.com/kamp-us/phoenix/issues/362) that ADR 0062 §3 deferred — and was
proven end-to-end against a real foreign repo (#368).

The **`adr`** skill is portable on the same shape. There is no committed
`.decisions/index.md` (ADR
[0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md),
supersedes 0066's storage half) and **no `SessionStart` ADR-map hook** (ADR
[0129](https://github.com/kamp-us/phoenix/blob/main/.decisions/0129-adr-discovery-is-the-claude-md-contract.md),
which drops 0126's map-injection hook as needless indirection): discovery is the CLAUDE.md
contract alone — `ls .decisions/` + each file's frontmatter — with the **`pipeline-cli
decisions-index compact`** subcommand (ADR
[0103](https://github.com/kamp-us/phoenix/blob/main/.decisions/0103-consolidate-pipeline-cli-package.md))
emitting the one-line-per-ADR map (`id · title · status`) from frontmatter to stdout **on
demand** (never auto-injected). The `@kampus/pipeline-cli` (SessionStart-installed by the
deps-install hook, a different hook entirely — [`.patterns/plugin-sessionstart-install.md`](https://github.com/kamp-us/phoenix/blob/main/.patterns/plugin-sessionstart-install.md))
is invoked the same way in phoenix and a foreign install; the CLI operates on the local
`.decisions/` tree, so it needs no repo resolution. On a PR, `decisions-index validate` remains the number-lock backstop (duplicate
/ mismatched `id` — #1471). The ADR PR is purely additive — it adds only the new file (plus
the superseded file's status edit), never a regenerated index.

### Validating portability in a foreign repo

**Start with `doctor`.** Before the first run in a freshly-adopted repo, run the `doctor`
skill (`claude-plugins/kampus-pipeline/skills/doctor/doctor.sh`) — it asserts the prerequisites in one pass (gh
auth + the `project` scope, the 15 required `status:*`/`type:*`/`p*` labels, repo
resolution, a CI signal, and the `@kampus/*` npm deps) and prints a tiered pass/fail
checklist with the exact `gh label create …` / `gh auth refresh …` fix command for each
gap. It turns "did I wire this up right?" into one checkable command instead of a first run
that fails deep inside a `gh api` call.

To re-prove a skill's gate runs outside phoenix (the repeatable procedure
behind #368 / #432), exercise it in a throwaway non-phoenix git repo — **not** phoenix
itself (the install-into-self caveat, §5 below, means phoenix doesn't count):

1. `mkdir` a scratch dir outside phoenix, `git init`, and create the inputs the skill
   consumes — e.g. for `adr`, a `.decisions/` with 2–3 ADR files carrying `id`/`title`/
   `status`/`date` front-matter (optionally a deliberately-stale `index.md` to prove
   regeneration overwrites it). Confirm no `@kampus/*` workspace package is present, so the
   installed `@kampus/pipeline-cli` is what runs.
2. Run the exact subcommand the skill uses (`adr`:
   `pnpm dlx @kampus/pipeline-cli@latest decisions-index generate`) from the scratch repo root.
3. Confirm a correct artifact is produced (`index.md` with one row per ADR, ordered by
   `id`, derived verbatim from front-matter) — not a `pnpm --filter` no-op and not an
   `ERR_MODULE_NOT_FOUND` / "matches nothing" failure.
4. Run the gate (`pnpm dlx @kampus/pipeline-cli@latest decisions-index check`): exit `0` on the fresh
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
│       ├── README.md                    # this file — the plugin's front-door entry point
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
