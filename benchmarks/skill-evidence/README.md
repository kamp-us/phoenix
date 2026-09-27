# skill-evidence

The benchmark-evidence surface for skills under `claude-plugins/fabrika/skills`:
the gate's policy, and the committed `report.json` evidence the gate judges.
Enforced by `fabrika guard skill-evidence-guard check` in
[`.github/workflows/skill-evidence-guard.yml`](../../.github/workflows/skill-evidence-guard.yml);
the why is [ADR 0406](../../.decisions/0406-skill-changes-carry-benchmark-evidence.md)
(founder ruling 2026-09-21): a skill change merges only with measured proof of
its benefit vs a baseline, produced by a trusted in-repo runner.

## What the gate does

For a PR that changes files under the skills root:

- A **removed** skill is recorded, never gated — no evidence is required to delete.
- A **typo-only** change is exempt, with the numbers named in the verdict so the
  exemption is auditable (see [Typo exemption](#typo-exemption)).
- Every other skill change must carry a committed
  `reports/<skill>/report.json` that is schema-valid, version-bound to the PR's
  skill content, provenanced to the trusted producer workflow, and passes the
  policy's thresholds. Missing, stale, mis-provenanced, or failing → the check
  reds (exit 12). A read the verdict rests on that could not be made (policy,
  report file, git, GitHub API, no `GITHUB_TOKEN`) → exit 11, never clean.

## `report.json` schema (schemaVersion 1)

One file per skill at `benchmarks/skill-evidence/reports/<skill>/report.json`.
Validation is positive: an unknown field or a wrong-typed one reds naming the
field path — nothing defaults silently.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Pins this schema. |
| `skill.name` | string | The skill's directory name. |
| `skill.path` | string | `claude-plugins/fabrika/skills/<name>`; must equal the actual path. |
| `skill.treeSha` | string | The skill directory's tree SHA at the PR head (`git rev-parse <head>:<skill.path>`, proven a tree by `git cat-file -t`). |
| `baseline.kind` | `"without-skill"` \| `"previous-version"` | See [Baseline semantics](#baseline-semantics). |
| `baseline.treeSha` | string? | The previous version's skill tree SHA; required for `previous-version`. |
| `model` | string | The model both arms ran on. |
| `tools` | string | The tool configuration both arms ran under. |
| `scenarioSet` | string | The named, fixed scenario set both arms ran. |
| `repetitions` | positive int | Repetitions per scenario; `>= thresholds.minRepetitions`. |
| `results.baseline` / `results.treatment` | [`Arm`](#arm) | The two measured arms. |
| `thresholds` | [`Thresholds`](#thresholds) | The exact threshold set the run was judged against. |
| `provenance.workflow` | string | The producer workflow path the run came from (self-report; the gate verifies the real one against the API). |
| `provenance.runId` | positive int | The producer workflow's run id. |
| `provenance.runUrl` | string | The run's URL — the human link a reader clicks to audit the numbers. |
| `provenance.headSha` | string | The commit the producer ran at. |

### Arm

| Field | Type | Meaning |
|---|---|---|
| `scenarios` | non-negative int | Scenario count; the two arms must match (one scenario set). |
| `success` | non-negative int | Successful scenario outcomes. |
| `criticalErrors` | non-negative int | Critical failures. |
| `tokens` | number | Total tokens consumed — recorded, never gated. |
| `costUsd` | number | Total cost in USD — the gated resource ratio. |

## Baseline semantics

- **New skill** (absent at the PR base): `baseline.kind` is `"without-skill"`
  — the baseline arm ran with the skill absent.
- **Updated skill** (present at the PR base): `baseline.kind` is
  `"previous-version"` AND `baseline.treeSha` equals the skill's tree SHA at
  the PR base — the baseline arm is the skill's own previous version. A wrong
  kind or a stale `baseline.treeSha` reds.

## Thresholds

`policy.json` declares `thresholds.default`, optionally overridden per skill
(`thresholds.perSkill.<skill>` replaces only the keys it names; a key the gate
does not know reds). The applied set is `default` merged with the skill's
override, and `report.thresholds` must deep-equal that applied set — evidence
is judged against the policy's numbers, never a set the report brought (no
post-hoc threshold shopping).

- `minRepetitions`: `repetitions >= minRepetitions`.
- `successDelta`: `treatment.success - baseline.success >= successDelta`.
- `newCriticalErrors`: `treatment.criticalErrors - baseline.criticalErrors <= newCriticalErrors`.
- `maxCostRatio`: when `baseline.costUsd > 0`, `treatment.costUsd <= baseline.costUsd * maxCostRatio`;
  over a zero-cost baseline, `treatment.costUsd <= baseline.costUsd + maxCostRatio`.

Plus: `treatment.scenarios === baseline.scenarios` (both arms ran the same
scenario set). `tokens` is recorded but never gated.

## Typo exemption

Narrow and content-based, so it survives a merge-queue re-run: a skill is
exempt when **every** changed file ends `.md`, the total changed words (removed
+ added) across those files is `<= maxChangedWords` (default 20), and every
changed word pair is within `maxWordEditDistance` (default 2) by Levenshtein
distance. A non-`.md` change (scripts, scorers, assets) or a rewrite exceeding
either cap never qualifies. The skip summary names the numbers (e.g. "2 changed
words across 1 .md file(s), max pair distance 1").

## Provenance contract

The report must have been produced by the workflow named in
`producerWorkflow` (today `.github/workflows/skill-benchmark.yml`). The gate
reads `GET /repos/<repo>/actions/runs/<provenance.runId>` and requires that
run to be a **completed, successful** run of exactly `producerWorkflow` whose
`head_sha` equals `report.provenance.headSha`; that head commit must be
present in the checkout, and the skill's tree SHA **at that commit** must
equal `report.skill.treeSha` — the trusted run measured the exact content the
report attests. No `GITHUB_TOKEN` in the environment, an unreachable API, or
an absent benchmark commit is UNKNOWN (exit 11), never clean.

**Artifact byte-binding.** A run existing proves a benchmark *ran*; it does
not prove the committed numbers are the run's. The producer must publish an
artifact named by `policy.reportArtifact` (today `skill-benchmark-report`)
whose zip carries `report.json`, and the gate downloads it and requires it to
be **byte-identical** to the committed report — commit the artifact's bytes
verbatim, no reformatting. The run publishing no such artifact, a download
that cannot be read, or an extraction that cannot run is UNKNOWN (exit 11);
bytes that differ is a violation (exit 12).

## The policy is read from the BASE commit

`policy.json` is read from the PR's **base** commit — never from the PR head,
with no fallback. A PR cannot relax its own thresholds, widen its typo
exemption, or move the report root it is judged under; nor can a head policy
relocate `skillsRoot` to make a skill change look skill-free, because the
head tree is never read for the policy at all. The one-time cost is honest:
the bootstrap PR that first lands the policy reds on its own gate until it
merges (land it skill-free in its own PR), and after that merge the base
always carries the policy. A failed git read while establishing any of this
(a skill's tree at base or head, the policy blob, a word-diff source) is
UNKNOWN, never "skill absent" — a read that failed never wears the shape of a
content fact, and neither does a present-but-wrong-shaped object (a blob at a
skill's path is "not a skill directory", never "removed").

## Out of scope

Raw transcripts, per-run logs, and scenario bodies never land here — only the
aggregated `report.json` (the `benchmarks/warp-skill-doctor-import-poc`
results boundary is the precedent: machine-local run artifacts stay out).

## Activation status

Advisory until the founder adds the job name `skill benchmark evidence` to the
main-protection ruleset. The producer workflow (which needs a model API secret
that does not exist yet) is a follow-up child; until it exists, any real skill
change reds for missing evidence.
