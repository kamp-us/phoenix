# GitHub repository setup reference

What fabrika needs from the repository on GitHub itself: the account that owns it, its visibility,
the merge queue, CI, and the `.github/CODEOWNERS` rows. The files fabrika reads inside the repo are
in [`adopt-fabrika-in-a-new-repo.md`](adopt-fabrika-in-a-new-repo.md). The steps to turn the queue
on are in [`turn-on-the-merge-queue.md`](turn-on-the-merge-queue.md).

The GitHub facts below were read from GitHub's own docs, linked in each row. GitHub changes its
plans, so re-read the linked page before you rely on one.

## Landing routes

`fabrika ship scope <pr>` prints the route the shipper lands a pull request by, on its `landing`
line:

| `landing` | When | What lands the PR |
|---|---|---|
| `queue` | a ruleset on the base branch carries the merge queue rule | `fabrika ship enqueue`, then `fabrika ship reconcile` |
| `direct` | no queue governs the base, and the repo allows at least one merge method | `fabrika ship merge`, with the method the line names |
| `none` | no queue, and the repo allows no merge method | nothing; someone with settings access turns a method on |
| `unknown` | the read failed | nothing yet; the shipper treats it as `queue`, and `ship merge` refuses on the same read |

**The merge queue is optional.** A repo with no queue lands every pull request on the `direct`
route, and every fabrika stage works there. The [queue requirements](#queue-requirements) below
apply only to a repo that turns the queue on.

fabrika finds the queue by reading the branch's ruleset rules
([Get rules for a branch](https://docs.github.com/en/rest/repos/rules)). Where the plan has no
rulesets, it reads the base as having no queue and lands `direct`.

## Account type and visibility

| Feature | Personal repo | Organization repo | fabrika uses it for | GitHub doc |
|---|---|---|---|---|
| Merge a pull request through the API | any visibility | any visibility | the `direct` route (`ship merge`) | [Merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) |
| Merge queue | not available | public repos; private repos only on GitHub Enterprise Cloud | the `queue` route | [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) |
| Rulesets, including required status checks | public repos on GitHub Free; private repos need GitHub Pro | public repos on GitHub Free for organizations; private repos need GitHub Team or Enterprise Cloud | holding the queue rule and the required check | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) |
| GitHub's own code owner review rule | public repos on GitHub Free; private repos need GitHub Pro | public repos on GitHub Free for organizations; private repos need GitHub Team or Enterprise Cloud | nothing fabrika needs; see below | [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) |
| Free GitHub Actions minutes | free on public repos with standard runners; private repos get the plan's included minutes, then are billed | the same | the CI that `ship checks` and `review ci` read | [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |

So the `direct` route works on a personal private repo. The `queue` route needs a repo owned by an
organization, and public unless the organization is on GitHub Enterprise Cloud.

Public repos run on standard GitHub-hosted runners for free. A private repo spends its plan's
included Actions minutes on every CI run, and a lane runs CI on each push it makes. Use past the
included minutes is billed to the account that owns the repo.

fabrika's control-plane check, `fabrika ship cp-approval`, reads `.github/CODEOWNERS` and the PR's
reviews itself. It works whether or not GitHub enforces code owner review on your plan.

## Queue requirements

These apply only to a repo whose base branch carries the merge queue rule.

- **Every workflow behind a required check needs the `merge_group` trigger.** The queue runs your
  required checks on its own temporary branch, and that run starts only on `merge_group`. A
  workflow without it never reports there, and the queued PR is not merged.
  ([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#triggering-merge-group-checks-with-github-actions),
  [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group))
- **A diff taken on a queue run reads `github.event.merge_group.base_sha`.** `github.base_ref` is
  set only on `pull_request` and `pull_request_target`, so it is empty on a `merge_group` run, and a
  step that diffs against `origin/$BASE_REF` has no base. The `merge_group` payload carries
  `base_sha`, the queue branch's parent commit.
  ([Contexts reference, `github.base_ref`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context);
  the `merge-group` schema in [GitHub's REST API description](https://github.com/github/rest-api-description))
- **A required check that a `paths:` filter can skip never reports.** When a workflow is skipped by
  a `paths:` or branch filter, its checks stay "Pending" and a PR that requires them cannot merge.
  A job skipped by its own `if:` reports "Success" instead.
  ([Workflow syntax, `paths`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore),
  [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks))
  So make one always-running gate job the only required check, and let it judge the conditional
  jobs. [Turn on the merge queue](turn-on-the-merge-queue.md#3-add-one-always-running-gate-job)
  gives a copyable one.

## The owner rows `codeowners-cp` demands

`fabrika guard codeowners-cp check` reds unless `.github/CODEOWNERS` has an owned row covering each
of these nine paths. The list is fixed in fabrika's code, so it is the same in every repo, including
paths your repo does not have:

```
/.claude/
/.github/
/.claude-plugin/
/packages/ci-required/
/packages/fabrika-cli/src/ci/
/biome.jsonc
/biome-plugins/
**/lefthook*
**/.lefthook*
```

With all nine covered, it prints:

```
guard codeowners-cp check: all 9 §CP path(s) are covered by .github/CODEOWNERS (9 owned rows)
```

A row covers a path when it names it or a directory above it, so a `/.github/` row covers every
file under `.github/`. A directory row does not cover a file of a similar name beside it.

`ship cp-approval` reads the whole file, so every owned row you add beyond these marks its paths
control-plane too, and a PR touching them waits for an owner's approval.

Which of the nine rows may change, and how the guard should pick its list, is still open in
fabrika's own tracker. This page names no row as optional.
