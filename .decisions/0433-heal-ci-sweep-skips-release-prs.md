---
id: 0433
title: heal-ci sweep leaves release-please release PRs out of its scope, never adding a stall token for them
status: accepted
date: 2026-09-30
tags: [fabrika, pipeline-hardening, heal-ci, release]
---

# 0433 — heal-ci sweep leaves release-please release PRs out of its scope, never adding a stall token for them

**What this decides:** `heal-ci sweep` does not list release-please release PRs at all. They are
merged by a person on purpose, so they are never stranded, and no new stall token is added to
describe them.

## Context

Every release-please PR classifies `linkage-refused` in a `heal-ci sweep`. Its body is the bot's
generated changelog, which carries no `Fixes #N` or `Part of #N`, and the bot regenerates that body
on every release. So each sweep reported two or three permanent stranded rows, and each release
added more. [#7289](https://github.com/kamp-us/phoenix/issues/7289) was first filed as "a standing
publish blocker". It is not one.

**The hand-merge of a release PR is the designed release flip, not a stranded PR, and no sweep
files it as a publish blocker.** The `ship` skill scopes itself as "not the human release flip",
and its §8 says "Deploy is yours; release is a human's", which is ADR
[0083](0083-agents-deploy-humans-release.md)'s split. The publish path that hangs off that merge is
ADR [0239](0239-release-please-manifest-mode-version-derivation.md) and ADR
[0292](0292-dispatched-publish-path-tag-bound.md).

`packages/fabrika-cli/src/heal-ci/stall.ts` classifies with an ordered chain over a closed
`STALL_TOKENS` vocabulary. A release PR is open, unwedged, surface-clean and CI-green, so the
`linkage-refused` arm fires before the attendance arms are reached. #7289 laid out four arms:
filter at the sweep, add a `human-release` stall token ranked above `linkage-refused`, widen what
`Part of #N` covers, or do nothing.

The founder ruled on 2026-09-01, in
[#7289 (comment)](https://github.com/kamp-us/phoenix/issues/7289#issuecomment-5505553300): the
first arm, filter at the sweep, with no new `human-release` stall token. The reason given is that
these are bot-authored PRs merged by hand that never need healing, and a token only adds
vocabulary for a case that is not a stall. This record transcribes that ruling.

## Decision

**A release-please release PR does not appear in `heal-ci sweep` output at all.**

**The class is the one #7289's first arm names:** a bot-authored PR whose head branch starts with
`release-please--branches--`. The sweep leaves such a PR out of its scope. It is not a stranded row
of any token, including `attended`.

**`STALL_TOKENS` does not change.** No `human-release` token is added, and `stall.ts`'s ordered
chain keeps its current arms in their current order. `linkage-refused` stays what it is: a true
statement about the grammar the shipper would apply, for PRs the shipper is asked to merge.

**The linkage grammar does not change either.** This ruling widens nothing about `Part of #N` and
mints no new issue-reference token. `Re: #N`, `Refs`, `See` and a bare `#N` stay banned, as the
`heal-ci` skill's §6 already says.

**The cost is accepted.** A release PR that is genuinely red drops off the sweep's board along with
the rest of the class. The person who merges it by hand sees its checks at merge time.

**Banned.**
- Reporting a release-please release PR as stranded, or filing it as a publish blocker.
- Adding a stall token for this class, or re-ranking `linkage-refused` to make room for one.
- Minting an issue-reference token, or asking the bot's body to carry one, to clear the
  `linkage-refused` reading on a release PR.

## Consequences

- The sweep code does not filter the class yet. That change is
  [#10258](https://github.com/kamp-us/phoenix/issues/10258): skip the class in
  `packages/fabrika-cli/src/heal-ci/sweep-verb.ts`, and say so in the `heal-ci` skill and the
  sweep's help. Until it lands, the permanent rows still show, and this record names them as the
  gap.
- `heal-ci diagnose <n>` on a single release PR is outside this record. It still classifies what it
  is asked to classify.
- The sweep's board loses visibility of a red release PR. Those PRs have one human owner by design,
  so no automated lane would have acted on the row anyway.
