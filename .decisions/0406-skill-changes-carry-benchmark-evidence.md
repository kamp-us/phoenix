---
id: 0406
title: Skill changes carry trusted benchmark evidence before they merge
status: proposed
date: 2026-09-21
tags: [fabrika, skills, ci, benchmarks]
---

# 0406 — Skill changes carry trusted benchmark evidence before they merge

**What this decides:** a PR that changes a skill under
`claude-plugins/fabrika/skills/` must carry committed benchmark evidence proving
the skill's benefit vs a baseline, produced by a trusted in-repo runner, bound
to the exact skill content the PR ships. The gate (`fabrika guard
skill-evidence-guard check`, workflow `.github/workflows/skill-evidence-guard.yml`)
lands advisory and becomes merge-blocking when the founder adds its job name to
the branch-protection ruleset.

## Context

Skills have been merging on argument, not measurement: a prompt or script
change under the skills root ships with no proof that the skill helps, and no
surface asks for one. The existing guard (`skill-doctor-tests.yml` and
`fabrika guard skill-lint check`) covers the vendored skill-doctor package's
upstream tests and the corpus's doc conformance — neither measures what a
skill does for an agent, and neither gates a skill change on benefit.

The founder ruled (conversation with Barış, 2026-09-21) that enforcement must
be a required CI check, not prose: a skill change merges only with benchmark
evidence of its benefit vs a baseline, produced by a runner the repo trusts.
This ADR transcribes that ruling and records the gate built to it.

## Decision

**`guard skill-evidence-guard check` gates skill changes on committed,
trusted, version-bound benchmark evidence.** The workflow hands the guard the
PR's changed files (`git diff --name-only --diff-filter=ACMRD base...HEAD`),
the base and head SHAs, and the repository name; the verb gathers the facts
(git trees, report contents, the GitHub run) and the pure judge in
`packages/fabrika-cli/src/guard/skill-evidence.ts` decides. Scope and shape:

- **Scope.** Files under `claude-plugins/fabrika/skills/` (from
  `benchmarks/skill-evidence/policy.json`), grouped by skill directory. A
  removed skill is recorded and not gated — no evidence is required to delete.
- **Baseline semantics.** A NEW skill's baseline arm is `without-skill` (the
  arm ran with the skill absent); an UPDATED skill's baseline arm is
  `previous-version` and its `baseline.treeSha` must equal the skill's tree at
  the PR base. Wrong kind or stale baseline tree reds.
- **Report contents.** `benchmarks/skill-evidence/reports/<skill>/report.json`
  (schema in that directory's README): success counts, critical-error counts,
  tokens, cost, repetitions, and the exact threshold set, for both arms.
  Tokens are recorded, never gated — cost is the gated resource ratio.
- **Thresholds.** The policy's `default` set merged with per-skill overrides;
  the report's `thresholds` must deep-equal the applied set (no post-hoc
  threshold shopping), then `repetitions >= minRepetitions`, the arms ran the
  same scenario set, `treatment.success - baseline.success >= successDelta`,
  `treatment.criticalErrors - baseline.criticalErrors <= newCriticalErrors`,
  and cost within `maxCostRatio` of the baseline (an absolute budget over a
  zero-cost baseline).
- **Trusted-runner provenance.** The report names the producer run; the gate
  reads that run off the GitHub API and requires a completed, successful run
  of exactly `policy.producerWorkflow` whose `head_sha` is a commit present in
  the checkout where the skill's tree equals the attested `skill.treeSha` —
  the trusted run measured the content the report attests. Self-reported
  numbers are never trusted on their own.
- **Stale-evidence refusal.** `report.skill.treeSha` must equal the PR's skill
  tree; any skill edit after the benchmark ran reds until the benchmark is
  re-run at the new content.
- **Typo exemption.** Narrow, content-based, auditable: every changed file
  `.md`, total changed words ≤ `maxChangedWords` (default 20), every changed
  word pair within `maxWordEditDistance` (default 2). The skip summary names
  the numbers. Non-`.md` changes (scripts, scorers, assets) and rewrites over
  the caps never qualify. Content-based on purpose: it answers identically on
  `pull_request` and `merge_group`, and the word-diff facts are computed by
  the verb in code (ADR 0228's relay-never-derive — the workflow relays the
  diff, the verb decides).
- **Missing or failing evidence reds** (exit 12) once the check is required; a
  read the verdict rests on that could not be made — policy, report file, git,
  the GitHub API, no token — is UNKNOWN (exit 11), never clean, per the
  group's fail-closed floor (ADR 0092).

**Adjacent rulings stay in their scopes.** Epic #8035's non-goal "gating
anything on a skill-doctor grade" is about the grader's letter grades — this
gate compares benchmark arms and never consumes a skill-doctor grade, so that
non-goal is untouched. ADR 0355's "privacy stays discipline-enforced, not
gate-enforced" is untouched too: this gate binds benefit evidence, not report
privacy — raw transcripts and run artifacts still stay out
(`benchmarks/warp-skill-doctor-import-poc` results boundary), with only the
aggregated report committed.

## Sequencing and activation

This change builds the GATE only. The benchmark producer workflow
(`policy.producerWorkflow`, `.github/workflows/skill-benchmark.yml`) needs a
model API secret that does not exist yet; it is a follow-up child, and an
admin adds the secret when it lands. Until the producer exists, any real
behavior-affecting skill change reds for missing evidence — that is the point:
no producer, no import.

The workflow lands advisory (it runs and reports honest verdicts, blocking
nothing). Activation is a founder action: add the job name
`skill benchmark evidence` to the main-protection ruleset's required checks —
the `merge_group` arm already covers the merge queue's ALLGREEN. Renamed skill
directories read as delete+add under the default `git diff --name-only`
resolution; that is accepted and documented.

## Alternatives considered

- **Prose policy ("show evidence in the PR")** — rejected by the ruling
  itself: prose has no fail-closed surface, and the merge that skips it looks
  identical to the merge that read it.
- **Gate on a skill-doctor grade** — rejected: the grader measures corpus
  hygiene, not a change's benefit over its own baseline, and #8035 explicitly
  ruled grading out of gate scope. Arm comparison is a different measurement.
- **Trust any committed report** — rejected: a report is just JSON a PR
  author writes; without binding it to a successful run of the designated
  workflow AND to the content tree that run measured, the gate would verify
  formatting, not evidence.

## Consequences

Every behavior-affecting skill change now costs a benchmark run before merge —
that is the ruling's price and its point. The typo lane keeps genuine
word-level fixes cheap. Re-synced vendored skills (a skill-doctor re-copy) are
behavior changes like any other and are gated unless a per-skill threshold
override is added to the policy with eyes open. Until the producer child
lands, the advisory gate reds on every real skill change — visible, honest,
and the forcing function for the producer's priority.

## Records

no vocabulary impact
