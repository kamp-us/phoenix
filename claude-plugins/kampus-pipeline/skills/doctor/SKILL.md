---
name: doctor
description: Verify a repo meets the kampus-pipeline prerequisites before its first triage / report / write-code / ship-it run, and print a tiered pass/fail checklist with the exact fix command for each gap. The role `ctx doctor` plays for context-mode — turns "did I wire this up right?" from tribal knowledge into one checkable command. Trigger on "doctor", "preflight", "is this repo set up for the pipeline", "check pipeline prerequisites", "verify pipeline setup", "/doctor", or when adopting the pipeline in a foreign repo.
---

# doctor

You verify that the **target repo is ready to run the pipeline** and hand back a
checklist — you do **not** fix anything. Every gap is reported with the exact
command that closes it; applying it is the operator's call (and most fixes mutate
the repo — label creation, auth scopes — which is theirs to authorize).

The pipeline is repo-agnostic (ADR [0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md)): an adopter installs the plugin and it
operates on *their* issues. Several skills hard-depend on environment the host repo
must already provide — labels, `gh` auth, a CI signal, a home to file work into —
but nothing verifies that up front. This skill closes that window.

A missing label does **not** announce itself: `POST /repos/{owner}/{repo}/issues/{n}/labels`
**auto-creates** the label it is handed (measured 2026-07-26 — HTTP 200, the label
materializes repo-wide at GitHub's default grey with no description). So `report` succeeds
and quietly mints an off-taxonomy label, and the failure surfaces later on the **read**
side, where `?labels=status:triaged` and every guard's label scoping match nothing and the
pipeline runs protecting nothing (#4300; the silent no-op ADR [0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md) exists to kill).

## Running it

Resolve nothing by hand — the helper resolves the target repo itself (the standard
`CLAUDE_PIPELINE_REPO`-else-current snippet) and runs every check:

```bash
claude-plugins/kampus-pipeline/skills/doctor/doctor.sh
```

It prints a tiered checklist and exits **0** only when every Tier-1 and Tier-2
check passed (Tier-3 gaps warn, never fail). Relay its output to the operator
verbatim — the per-line `↳ fix:` commands are the load-bearing part — then stop.
Do not run the fix commands yourself.

## What it checks

| Tier | Check | Why it's here |
|---|---|---|
| **1 — load-bearing** | `gh` authenticated | every call is `gh api`; without auth nothing runs |
| | `gh` token has the `project` scope | the org's Projects-classic integration requires it (the reason the suite is REST-only, never GraphQL) |
| | the required labels exist (`status:*` spine, `type:*` class, `p*` priority, the two standing lanes, the platform discriminator) | the intake skills key on them — `report` applies `status:needs-triage`, `write-code` picks `status:triaged`, `triage` exempts to `wayfinder:backlog` / `axis:pipeline-hardening`. A missing one makes every scan match nothing. |
| | that set still covers the shared vocabulary | the create-commands table carries colours the source can't; this asserts it hasn't fallen behind the source (below) |
| **2 — gating** | target repo resolves | a skill can't target a repo it can't name |
| | at least one CI workflow exists | `ship-it` Step 3 gates on checks-green; with zero checks that gate passes vacuously |
| | repo-level `allow_auto_merge` is enabled | `ship-it`'s `gh pr merge --auto` cannot arm without it — the enqueue fails with `Auto merge is not allowed for this repository (enablePullRequestAutoMerge)` (ADR [0132](https://github.com/kamp-us/phoenix/blob/main/.decisions/0132-merge-queue-for-base-freshness.md) §Addendum §1) |
| | a `merge_queue` rule applies to the **resolved** default branch | `ship-it` deliberately passes no merge-method flag because the queue owns it (ADR 0132 §Consequences); with no queue there is no method and the merge never lands |
| **3 — optional** | `@kampus/pipeline-cli` resolves on npm | `adr` / `review-plan` reach for its `decisions-index` / `epic-ledger` tools via `pnpm dlx` as the published fallback (epic #994); absent → those stages degrade |
| | a `run-evidence` producer is defined | `ship-it` guard 2 runs strict when present, and **degrades to checks-green when absent** (ADR [0086](https://github.com/kamp-us/phoenix/blob/main/.decisions/0086-ship-it-foreign-repo-degradation.md)) — so this is informational, not a failure |
| | the ideation-layer labels exist (`wayfinder:map`) | `wayfinder` keys its map issue on it; it is an ideation front door, not a first-run prerequisite |
| | at least one **open milestone** exists | `triage` Step 6 homes an issue into an arc/campaign milestone and **never creates one** (ADR [0072](https://github.com/kamp-us/phoenix/blob/main/.decisions/0072-milestones-encode-strategic-sequencing.md) §3). With none, triage can still exempt to a standing lane but cannot home into an arc — a WARN, never a fail, because a freshly-adopted repo legitimately has none yet |

The load-bearing pair is **auth + labels** (Tier 1). The Tier-2 checks keep `ship-it`
honest; Tier-3 only ever downgrades a single stage.

The last two Tier-2 checks are the **repo-admin governance pair**, and they are the one
prerequisite class this checklist can only *report*: `allow_auto_merge` and the
default-branch merge-queue ruleset are GitHub-side repo settings that **no repo-scoped
script can create** — not doctor, not any stand-up script. They also fail *last*, at the
enqueue, after an adopter has already built, reviewed, approved, and armed a PR. Reading
them up front is what turns that finish-line halt into a first-run checklist line.

Every check reports **three** states, never two: present, absent, and **UNDETERMINED** —
the read itself did not succeed. A failed label read is not "no labels", and no open
milestone found is not "the milestone read worked". Collapsing those is what lets a
checker pass while the thing it checks is absent, so doctor names the unknown as unknown
and still fails closed on it.

## Conventions

- **Read-only.** The helper never mutates the repo — it reads state and prints fix
  commands. The fixes (`gh label create …`, `gh auth refresh -s project`) are for a
  human to run; surfacing them is the whole job.
- One run, one checklist. This is a preflight, not a repair loop — it does not
  re-check after a fix; the operator re-runs it.
- **An unreadable state is UNKNOWN, never the negative answer.** A 403/404/5xx/empty body
  reds with a reason that says *the read failed* — never "auto-merge is disabled", which is
  a different fact. `gh api` prints its error body to stdout **without** applying `--jq`, so
  every read keeps gh's exit status and admits only the literal values it expects (§ZS /
  ADR [0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md); the defect class of #4223).
- **`doctor.sh`'s `LABELS` table is a presentation mirror, not the source.** The required
  set is single-sourced in `packages/pipeline-cli/src/tools/vocabulary-preflight/vocabulary.ts`,
  which assembles it from the constants the guards themselves scope on; the table only adds the
  colour + description a `gh label create` needs. Doctor reads the source through
  `pipeline-cli vocabulary-preflight labels` and **reds if the table has fallen behind it**, so
  the two cannot silently diverge — the drift that shipped as #4300. Change the vocabulary at
  the source, then add the matching row here.
