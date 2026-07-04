---
id: 0140
title: "phoenix[bot] GitHub App authors pipeline PRs → team-based §CP: a bot-authored PR is approvable by ANY @kamp-us/control-plane member (usirin + cansirin today, extensible as the team grows), because the bot's distinct authorship makes every human team member a valid non-author approver — no ruleset change"
status: accepted
date: 2026-07-03
tags: [pipeline, control-plane, governance, github, github-app, security, ship-it, epic]
---

# 0140 — phoenix[bot] authors pipeline PRs: team-based §CP (any control-plane member approves)

## Context

Every agent-opened PR today is authored by the human `usirin` (the single-token shape, #382). GitHub excludes a PR's author from approving it, so a `usirin`-authored §CP PR can never be cleared by `usirin` — only the *other* control-plane member, `cansirin`, can satisfy `require_code_owner_review`. That is the **author-is-the-bottleneck** problem: the single human who drives the pipeline is also the author of everything it produces, so on every §CP PR he is structurally excluded and a *specific* second person is conscripted. The `#1907`/`#1910`/`#1927` approve-and-re-ping dance is the symptom; the author identity is the root.

`#1926` settled the *mechanism* — a **GitHub App (`phoenix[bot]`), not a machine-user account**: short-lived installation tokens (no long-lived PAT to leak or rotate — this *retires* the `#382` single-token hole rather than relocating it), no collaborator seat, and an unmistakable `[bot]` identity so automation is legible as automation. What `#1926` deferred to this ADR is (1) a **grounded verify** that an installation-token author actually frees the human approvers, (2) the **governance shape** it unlocks, and (3) the **provisioning** decomposition.

This ADR records the accepted decision on all three, grounded against a live differential and GitHub's documentation rather than asserted (the grounding bar).

## Decision

### 1. phoenix[bot] authors pipeline PRs; the driving human is co-author

The pipeline authenticates as the `phoenix[bot]` GitHub App via a short-lived **installation access token** and opens PRs under that identity. The driving human is preserved as a `Co-authored-by:` commit trailer — the bot is PR *author*, the human is co-author. This is not new machinery: the repo already carries a `Co-Authored-By: Claude …` trailer on ~2100+ commits using a non-personal `noreply@` address. The human co-author trailer follows the same abstract shape — `Co-authored-by: <name> <noreply-form address>` — and **never** embeds a personal email (the repo's no-PII rule).

A GitHub App **cannot be a code owner** — CODEOWNERS supports only users, teams, and user-emails (GitHub docs, *About code owners*), so `phoenix[bot]` is not listed there and its own review never satisfies `require_code_owner_review`. The bot's job is **distinct authorship, not approving**. (An App *can* POST an `APPROVE` review via the API with `pull_requests:write`, but that approval does not count toward code-owner review — the two facts are independent.)

### 2. Team-based §CP — a bot-authored PR is approvable by ANY @kamp-us/control-plane member

With `phoenix[bot]` as author, **no human is the author** of pipeline PRs — so **every** member of the `@kamp-us/control-plane` team is a valid *non-author* approver. Today that is `usirin` and `cansirin`; as the team grows, each new member is automatically a valid approver with no further change. The gate is satisfied by **one code-owner-team approval from any member**, and because the `main` ruleset already requires exactly that — `required_approving_review_count: 0` **plus** `require_code_owner_review: true`, where the code owner of every §CP path is the team — **no ruleset change is required**: the count stays `0`, `require_code_owner_review` stays `true`, CODEOWNERS still maps §CP paths → `@kamp-us/control-plane`.

This is the intent behind `#1926` (the founder's own words): *"as long as a bot opens a PR, anyone from `@kamp-us/control-plane` should be able to approve — today me + cansirin, tomorrow more."* The point is **not** to designate a sole approver, and **not** to conscript a fixed second human — it is to make the **team** the approver pool and let any one member clear a bot-authored §CP PR. The §CP gate gets **cleaner, not weaker**: it is still a real code-owner approval by a control-plane human on every §CP change; it simply no longer excludes the driving human as author, nor forces one specific other person, nor caps the pool at two.

### 3. This resolves #1875 and clarifies ADR 0055

`#1875` — `usirin` cannot clear a `usirin`-authored §CP PR — **dissolves**: the unclearable case only existed because author == approver. It is a GitHub *platform* rule (an author cannot approve their own PR), **distinct** from ADR [0055](0055-acl-sourced-review-authz.md), which sources review authorization from the repo ACL (write+ humans are trusted reviewers, agents are not). ADR 0055 is unchanged; this ADR removes the *author*-side collision — GitHub's author-exclusion — by moving the PR author off every human onto the bot, which no reviewer-authorization rule could reach.

## Grounding (verified, not asserted)

- **Live differential (the mechanism, proven):** §CP PRs authored by a non-`usirin` control-plane member that `usirin` approved and that merged — `#1839` (cansirin-authored, §CP, `usirin` APPROVED, merged) and `#1656` (same shape). These prove a control-plane member's approval satisfies the §CP code-owner requirement whenever that member is not the author — exactly the mechanism `phoenix[bot]` authorship generalizes to the *whole team* (bot-as-author in place of any-human-as-author, so no human is ever the author). Conversely `#1927` (usirin-authored §CP) required `cansirin` — the author-bottleneck, live.
- **Bot = distinct author (GitHub docs):** *Authenticating as a GitHub App installation* — "API requests made by an app installation are attributed to the app." An installation-token-opened PR is authored by `phoenix[bot]`, a distinct account from any human, so no team member is the author and any may approve.
- **Apps are not code owners (GitHub docs):** *About code owners* documents only `@username`, `@org/team`, and user-email entries — no App entry type. So the bot cannot satisfy code-owner review by approving; its role is authorship only.
- **Author self-approval (GitHub docs):** *Approving a pull request with required reviews* — "Pull request authors cannot approve their own pull requests." (Documented as the Approve action being unavailable to the author; the practical effect is that an author cannot produce a counting approval.)

## Pre-reliance gate (a checked acceptance gate on the provisioning epic, not a footnote)

GitHub extends author-exclusion to a human who *triggered* an automated author in at least one documented case: *Approving a pull request with required reviews* — "You will also not be able to approve a pull request that was raised by GitHub Copilot if it was you who assigned Copilot to the issue." This is **Copilot-specific**; there is **no documented analogue for general GitHub-App installation authorship**, so the team-based mechanism most likely holds. But if a control-plane member's own automation triggers `phoenix[bot]` to open the PR, there is a non-zero risk GitHub treats *that member* as the triggerer and excludes their approval — which would narrow the approver pool for that member's own runs and could defeat this decision.

Therefore, **before the pipeline relies on team-based §CP**, the provisioning epic's milestone 1 MUST smoke-test it live: open a real `phoenix[bot]`-authored §CP scratch PR *triggered from a control-plane member's automation*, have that member approve, and confirm `mergeable_state` clears at required-checks-green (the code-owner-teeth differential). This is a **blocking acceptance gate**, not advisory — if it fails, the triggerer is excluded and the decision must be revised (e.g. a member cannot approve their own automation's runs, so a second member is still needed for those).

## Merge-queue & token interaction (grounded)

- The default `GITHUB_TOKEN` **cannot** add a PR to a merge queue; enqueuing requires "a personal access token or a GitHub App token that has permission to merge" (GitHub docs, *Automating Dependabot with GitHub Actions*). So the enqueue step (ADR [0132](0132-merge-queue-for-base-freshness.md)) must run under the `phoenix[bot]` installation token, not `GITHUB_TOKEN`.
- Installation permissions: **open PRs → `pull_requests:write`**; **merge/enqueue → `contents:write`** (plus `pull_requests:write`). There is **no dedicated merge-queue permission scope** — enqueuing rides on merge permission (`contents:write`).
- GitHub's merge-queue docs are silent on how the queue interacts with `require_code_owner_review` (they name only required *status checks*); our own live runs confirm code-owner review is enforced pre-merge regardless of the queue, so no change to that gate is implied.

## Consequences

- **This ADR decomposes into the `phoenix[bot]` provisioning epic** (#1934, a follow-on `type:epic` gated by this decision): App creation + registration; permission scoping (`pull_requests:write` + `contents:write`); credential storage and pipeline authentication as the installation; CI wiring so PR-open and enqueue run under the installation token (not `GITHUB_TOKEN`); the `Co-authored-by:` trailer wiring; the milestone-1 pre-reliance smoke-test gate above; and cut-over of the agent PR-open path from `usirin` to `phoenix[bot]`. It **retires #382** — the single-token hole is closed, not relocated, by the short-lived installation-token posture.
- **The enqueue mechanics for skills-class §CP PRs are tracked separately** (#1932, **pending resolution**): a §CP PR that touches a gate-critical *skill* currently cannot present a bindable `review-skill` PASS to `ship-it`, so bot-authorship (which fixes *who may approve*) is necessary but not sufficient for auto-enqueue of that class until #1932 is resolved. This ADR is about authorship identity and the approver pool; the skills-class verdict-binding path is #1932's to settle and is **not decided here**.
- **Scope boundary:** this is the git/GitHub *authorship identity* layer only. It is distinct from `#145`/`#41` (künye in-app agent identity), a different layer that this ADR does not touch.
- **Until the epic lands and its milestone-1 gate passes,** the pipeline keeps authoring as `usirin` and the author-bottleneck remains; this ADR authorizes the direction, the epic delivers it, and the smoke-test gate is what flips reliance to team-based §CP.
