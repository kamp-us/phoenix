# A repo-wide gate runs on `push: main` too

A gate whose scope is the **whole tree** cannot be charged correctly by a `pull_request`
trigger alone. Two PRs can each be green on their own and red only in combination — one
renames a file, the other links to the old name — and nothing evaluates that pair until
the next unrelated PR opens. That PR then goes red for a break its author did not cause,
and the author who caused it never sees a failure
([#5085](https://github.com/kamp-us/phoenix/issues/5085); it burned three unrelated
branches in one day).

**The rule.** If a workflow's guard scans repo-wide, it carries both triggers:

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

If the guard's scope really *is* the PR diff (`git diff base...HEAD`, `merge-base..HEAD`,
a PR's review threads), it stays `pull_request`-only — and says so in a comment at its
`on:` block, so the exclusion is auditable rather than an omission.

Keep `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`. On `main` a cancelled
run is a silently skipped gate; that expression is dead under a PR-only trigger and only
becomes live once a `main` run exists.

## What a `push: main` run does and does not do

It **attributes** the break to the commit that caused it, at the moment it lands. It does
**not** prevent the landing — the merge result is still unchecked unless the workflow also
carries `merge_group:` and the check is required. Those are separate calls, open at the
time of writing (#5085's carried-forward questions).

## The audit (2026-08-09)

Every `pull_request`-triggered workflow in `.github/workflows/`, classified by guard scope.

**Repo-wide → gained `push: main`** (18): `a11y-pbt`, `catalog-guard`,
`change-detect-guard`, `codeowners-cp`, `decisions-index`,
`design-inventory-guard`, `design-token-guard`, `doc-links`, `fanout-guard`,
`migrations-guard`, `patch-guard`, `path-filter-guard`, `pointer-guard`,
`publish-isolation-guard`, `readme-guard`, `settings-env-guard`, `workflow-contract`.
(The audit named 20; `crew-fanout-guard` and `crew-leak-guard` left with the crew, ADR
[0279](../.decisions/0279-v1-crew-retired-in-full.md), and `commands-guard` retired in
[#6098](https://github.com/kamp-us/phoenix/issues/6098) — fabrika's own unit suite already
enforces the property it gated.)

**Deliberately left `pull_request`-only** (5):

| Workflow | Why |
|---|---|
| `gitleaks` | Scans `merge-base..HEAD`, the PR's net-new commits. A `main` run re-scans the triaged #2325 history baseline and reds every time. |
| `leak-guard` | Scans `git diff base...HEAD`, the change under review. A `main` run would re-scan history instead. |
| `run-evidence` | Not a gate — a per-PR-head evidence producer whose consumers key on the PR head SHA. |
| `unresolved-threads-guard` | Reads a PR's review threads; a `push` carries no PR number. |
| `roadmap-guard` | Repo-wide, but its `milestone` event and weekly schedule already cover post-merge drift. |

**Already carried `push: main`** (6): `adoption-lint`, `ci`, `cli-invocation-guard`,
`deploy`, `skill-gh-lint`, `trap-status-guard`. (`cli-invocation-guard` and
`trap-status-guard` retired in [#6098](https://github.com/kamp-us/phoenix/issues/6098);
`skill-gh-lint` kept the trigger through its port.)

Workflows with no `pull_request` trigger at all (schedules, issue events, release events)
are out of scope: `changelog`, `epic-autoclose`, `homing-guard`, `orphan-sweep`,
`pr-cleanup`, `publish`, `release-please`. (`cp-bank-guard` and `orphan-heal` retired in
[#6097](https://github.com/kamp-us/phoenix/issues/6097); `glossary-drift` and `pitch-guard`
lost their wiring in that batch with no authorizing record and were restored onto the
`fabrika guard` surface under the founder ruling on
[#5720](https://github.com/kamp-us/phoenix/issues/5720#issuecomment-5337358152).)
