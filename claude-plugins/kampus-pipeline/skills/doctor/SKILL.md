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
must already provide — labels, `gh` auth, a CI signal — but nothing verifies that
up front, so a first run otherwise fails deep inside a `gh api` call (e.g. labeling
with a `status:needs-triage` that doesn't exist) instead of failing fast with a
clear "this repo isn't set up" message. Worst case it half-applies: an issue gets
created, then the label step errors, leaving an untracked issue outside the queue.
This skill closes that window.

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
| | the 15 required labels exist (`status:*` spine, `type:*` class, `p*` priority) | the intake skills key on them — `report` applies `status:needs-triage`, `write-code` picks `status:triaged`, etc. A missing one fails a run mid-`gh api`. |
| **2 — gating** | target repo resolves | a skill can't target a repo it can't name |
| | at least one CI workflow exists | `ship-it` Step 3 gates on checks-green; with zero checks that gate passes vacuously |
| **3 — optional** | `@kampus/pipeline-cli` resolves on npm | `adr` / `review-plan` reach for its `decisions-index` / `epic-ledger` tools via `pnpm dlx` as the published fallback (epic #994); absent → those stages degrade |
| | a `run-evidence` producer is defined | `ship-it` guard 2 runs strict when present, and **degrades to checks-green when absent** (ADR [0086](https://github.com/kamp-us/phoenix/blob/main/.decisions/0086-ship-it-foreign-repo-degradation.md)) — so this is informational, not a failure |

The load-bearing pair is **auth + labels** (Tier 1): get those wrong and the very
first `report` → `triage` round trips into a raw GitHub API error. The Tier-2 pair
keeps `ship-it` honest; Tier-3 only ever downgrades a single stage.

## Conventions

- **Read-only.** The helper never mutates the repo — it reads state and prints fix
  commands. The fixes (`gh label create …`, `gh auth refresh -s project`) are for a
  human to run; surfacing them is the whole job.
- One run, one checklist. This is a preflight, not a repair loop — it does not
  re-check after a fix; the operator re-runs it.
- The required-label set in `doctor.sh` is the canonical one (name + color +
  description). If the pipeline's label dimensions change (see
  [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §Pipeline labels), update the `REQUIRED_LABELS`
  table there so a fresh adopter gets the current set.
