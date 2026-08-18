---
id: 0292
title: The dispatched publish path is a second way to start a publish run, bounded to a tag
status: accepted
date: 2026-08-18
tags: [release-engineering, ci, npm, pipeline]
---

# 0292 — The dispatched publish path is a second way to start a publish run, bounded to a tag

**What this decides:** Something other than the GitHub Release event can now start the npm publish job — release-please's own workflow can, because the release it cuts raises an event GitHub ignores. Nothing else changes: the job still only ever publishes a tagged tree, and a tag still only exists because a human merged the Release PR.

## Context

ADR [0239](0239-release-please-manifest-mode-version-derivation.md) records the version-derivation half of this repo's release path and states, as part of its Decision, that "the existing OIDC `pnpm publish` job **on the release event** is still the only thing that ships a tarball," carried forward as "No automation tags or publishes; only a human merging the Release PR does."

That mechanism does not work, for a reason 0239 could not have known. release-please runs with `secrets.GITHUB_TOKEN`, and **GitHub creates no workflow run for an event raised with that token** — the documented behaviour is that "a new workflow will not run even when the repository contains a workflow configured to run when `push` events occur," with `workflow_dispatch` and `repository_dispatch` named as the two exceptions that always create a run whatever token raised them ([GitHub Docs, "Trigger a workflow"](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)). So the `release: published` event on a bot-cut release starts nothing: on 2026-08-16 the `fabrika-cli-v0.2.0` and `pipeline-cli-v0.3.0` tags sat unpublished until a human draft-cycled both releases with a user token. #5718 is the ticket.

Two routes close it. An App installation token passed to the action fixes every invisible event at once, but the repo holds no App or PAT secret and registering one is a founder act. The other is the documented dispatch exception, which needs no new credential — and that is what this repo takes, for now.

The choice matters beyond the mechanics because it moves what may reach npm off a durable, auditable object (a published GitHub Release) and onto a workflow dispatch. That is the part 0239 rules on, so it is the part this record bounds.

## Decision

**`publish.yml` also fires on `workflow_dispatch`, and `release-please.yml` dispatches it at `ref: <tag>` for each tag its run created — but the job refuses any dispatch whose `github.ref` is not `refs/tags/…`, so the set of trees that can reach npm is unchanged: tagged ones, cut from a Release PR a human merged.**

1. **The tag-ref refusal is the first step of the job**, ahead of the checkout, so a refused ref is never fetched and no OIDC credential is minted for it. It exists because the grammar gate downstream reads `github.ref_name`, which is the short name of a branch as readily as a tag: without the refusal, a branch named `fabrika-cli-v9.9.9` whose `package.json` reads `9.9.9` would clear both the grammar arm and the version-equality arm and publish an unmerged tree. npm versions are immutable (0239's own binding constraint, inherited from ADR [0076](0076-decisions-index-npm-publish-automated-release.md)), so that publish could never be taken back.

2. **`publish.yml` keeps its filename.** npm Trusted Publishing binds to repo plus workflow filename, not to the event that started the run, so a second trigger in the same file leaves the registration intact where a second file would break it. This is why the fix is a trigger and not a workflow.

3. **The same dispatch exception carries the other half of #5718**: `ci.yml` and `leak-guard.yml` gain `workflow_dispatch` so `release-please.yml` can kick the standing Release PR's required checks at its current head, which the bot's branch pushes likewise cannot start. That half decides nothing about what reaches npm and is recorded here only so a reader finds one story rather than two.

4. **0239's substance survives; its mechanism is amended.** The human still merges the Release PR, the merge is still what tags, and every dispatch this repo makes is downstream of that merge. What is no longer true is 0239's sentence that the release event is the *only* thing that ships a tarball. 0239 carries an `amended-in-part by` pointer to this record; its body is untouched.

5. **An App token supersedes all of it.** If the founder later registers a GitHub App and its installation token replaces `secrets.GITHUB_TOKEN` in `release-please.yml`, the bot's events become visible, both dispatch steps become dead code, and `workflow_dispatch` should come back off `publish.yml` with them. That swap changes how this repo authenticates CI-triggering bots and needs its own ADR when it happens.

## Consequences

- A release cut needs no hand-work: no close/reopen on the Release PR, no draft-cycle on a GitHub Release.
- The publish path now has two entrances to audit instead of one. The tag-ref refusal is what keeps the second entrance from being a wider door, so it is load-bearing — a change that removes or weakens it re-opens the hazard 0239 names as permanent.
- The two dispatch steps in `release-please.yml` are ordered and independently gated (the publish dispatch first, the check-kick under `!cancelled()`) so one half's failure never suppresses the other. An unpublished tag is the costlier failure; it goes first.
- `release-please.yml` now needs `actions: write` (to dispatch) and `checks: read` (for the idempotency probe) on top of the `contents: write` / `pull-requests: write` it already held.
- The check-kick step hard-codes the map from workflow file to required check-run name, while the required set itself lives in the repo's branch ruleset. That is a drift surface: a required check added to the ruleset and not to the map will never run on the Release PR. The step reds when a mapped workflow loses its `workflow_dispatch:` trigger, which catches the other direction only.
