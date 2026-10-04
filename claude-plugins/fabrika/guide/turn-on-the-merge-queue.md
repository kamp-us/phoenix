# Turn on the merge queue

Use this when you want the shipper to land pull requests through GitHub's merge queue. It is
optional: with no queue, `fabrika ship merge` lands each PR directly. Why the two routes exist, and
what each needs, is in [`github-repository-setup.md`](github-repository-setup.md).

You need a repo that already runs fabrika, and admin access to it.

## 1. Check the repo can have a queue

The merge queue is only for a repo owned by an organization, and public unless the organization is
on GitHub Enterprise Cloud
([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
A personal repo has no queue, so move it to an organization first.

## 2. Add `merge_group` to every workflow behind a required check

```yaml
on:
  pull_request:
  merge_group:
```

Without it, the queue's run of that check never starts and the queued PR does not merge.

Drop any `paths:` or `paths-ignore:` filter from these workflows. A required check whose workflow a
path filter skipped stays "Pending" forever. Skip work inside the workflow with a job `if:`
instead, as in the next step.

If a step diffs the change against its base, read the base from
`github.event.merge_group.base_sha` on a queue run. `github.base_ref` is empty there:

```yaml
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: diff
        env:
          BASE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || format('origin/{0}', github.base_ref) }}
        run: |
          files=$(git diff --name-only "$BASE...HEAD" | tr '\n' ' ')
          echo "files=$files" >> "$GITHUB_OUTPUT"
```

## 3. Add one always-running gate job

Make one job the only required check, and have it read the result of every job it guards. It runs
on every event, so it always reports, and it fails when a job it needs failed or was cancelled:

```yaml
name: ci
on:
  pull_request:
  merge_group:

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      files: ${{ steps.diff.outputs.files }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: diff
        env:
          BASE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || format('origin/{0}', github.base_ref) }}
        run: |
          files=$(git diff --name-only "$BASE...HEAD" | tr '\n' ' ')
          echo "files=$files" >> "$GITHUB_OUTPUT"

  test:
    needs: changes
    if: ${{ contains(needs.changes.outputs.files, 'src/') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test

  ci-required:
    needs: [changes, test]
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - env:
          RESULTS: ${{ join(needs.*.result, ' ') }}
        run: |
          for result in $RESULTS; do
            case "$result" in
              success|skipped) ;;
              *) echo "a job this gate needs ended $result"; exit 1 ;;
            esac
          done
```

Put every job you want enforced in the gate's `needs:`. `if: ${{ !cancelled() }}` keeps the gate
running when a job it needs failed or was skipped, so it reports a result instead of skipping too.

This gate reads every `skipped` as a pass. That is right for a job skipped by its own `if:`, and
wrong for one that should have run and did not. A stricter gate closes that gap: have the job that
decides what runs also output, per job, whether it should run, pass both that output and the job's
result to the gate, and fail any job that should have run and did not succeed.

## 4. Require the queue and the gate in a ruleset

Add a branch ruleset that targets your default branch, with its enforcement set to **Active**, and
give it two rules:

- **Require status checks to pass before merging**, with `ci-required` as the one required check
  ([Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging)).
- The merge queue rule, which the REST API names `merge_queue`: "Merges must be performed via a
  merge queue" (the `repository-rule-merge-queue` schema in
  [GitHub's REST API description](https://github.com/github/rest-api-description)).

fabrika finds the queue by reading the branch's ruleset rules
([Get rules for a branch](https://docs.github.com/en/rest/repos/rules)), so put the queue in a
ruleset rather than a classic branch protection rule.

## 5. Check the shipper sees the queue

Open a pull request, let its checks run, then:

```bash
fabrika ship scope <pr>
```

Its `landing` line reads:

```
landing	queue	-
```

If the line reads `direct` instead, fabrika read no queue on the base. Check that the ruleset's
enforcement is **Active** and that it targets the PR's base branch.
