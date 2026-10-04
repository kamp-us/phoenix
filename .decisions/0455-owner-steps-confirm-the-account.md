---
id: 0455
title: An owner-only step confirms the GitHub account that acted, never the person behind it
status: accepted
date: 2026-10-04
tags: [fabrika, governance, pipeline, control-plane, docs]
---

# 0455 — An owner-only step confirms the GitHub account that acted, never the person behind it

**What this decides:** fabrika's owner-only steps check which GitHub account acted. They do not
check that a person did. The checks stay as they are, and the guide, the skills and the command
messages say so. Running agents under a second GitHub account is the documented way to get a real
separation, and nobody has to do it.

## Context

fabrika has six steps it calls owner-only: the UI hand-check, the `pitch-approved:` comment, the
`bet` row on the betting table, `fabrika plan approve`, `fabrika decision rule`, and the sole-owner
self-approval of a control-plane pull request. Each one reads a GitHub account: the author of a
comment, the account that set a field, or the account a token belongs to.

On a repo with one GitHub account, agents post as that account. A usability test on 2026-10-03
([#10363](https://github.com/kamp-us/phoenix/issues/10363)) ran a newcomer through the published
guide on such a repo. The session reported a "screen check passed" record standing on the builder's
own screenshot comment. The newcomer had read that an agent "must never post that OK for you", and
nothing in the check told the two apart.

The source already says the limit.
[`packages/fabrika-cli/src/ship/roster.ts`](../packages/fabrika-cli/src/ship/roster.ts) says the
roster "does not prove a human typed the command; nothing mechanical can".
[`packages/fabrika-cli/src/guard/pitch.ts`](../packages/fabrika-cli/src/guard/pitch.ts) says "GitHub
authorship cannot separate founder from agent". The pages an adopter reads did not say it. They said
"the owner's hand-check", "the founder's verb" and "never agent-satisfiable".

The question put to the founder was whether an owner-only check needs a signal an agent cannot
carry, or whether the words should say what the check can tell. He ruled option A on 2026-10-03, on
[#10363, comment 5974828047](https://github.com/kamp-us/phoenix/issues/10363#issuecomment-5974828047).
This record writes that ruling down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

ADR [0210](0210-direction-binds-at-intake.md), ADR
[0289](0289-founder-approves-every-epic-plan.md), ADR
[0175](0175-cp-self-approval-cardinality-check.md) and ADR
[0425](0425-a-bet-set-on-founder-say-so-approves.md) each rule who holds one of these steps. ADR
[0071](0071-enforce-control-plane-at-github.md) and ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) put the control-plane
approval on `CODEOWNERS` and call that list human-only. This record changes none of them. They say
who should act. This one says what the check behind each step can prove: that an account on the list
acted.

## Decision

**An owner-only step confirms the GitHub account that acted, and every page and message that
describes one says account.**

- **The checks stay exactly as they are.** No verb's accepted input, refusal or exit code changes.
- **What each step reads.**

  | Step | The account it reads | The bar |
  |---|---|---|
  | UI hand-check | the comment's author | on the control-plane roster |
  | `fabrika plan approve` | the account running the verb | on the control-plane roster |
  | `fabrika decision rule` | the account running the verb | on the control-plane roster |
  | sole-owner self-approval | the comment's author | the one control-plane owner, who also authored the pull request |
  | `pitch-approved:` comment | the comment's author | write access |
  | `bet` row | the account that set the Stage | write access |

  The control-plane roster is the set of accounts the control-plane rows of `.github/CODEOWNERS`
  resolve to. The hand-check and the `pitch-approved:` comment also refuse a comment that carries an
  agent stamp. A comment with no stamp passes on its author alone.
- **The rule about who performs the step is the agent's to keep.** An agent still leaves an owner
  step to the owner, or performs it only on the owner's instruction where an earlier record allows
  that. On a one-account repo no check enforces this. The skills say so in those words.
- **A second GitHub account for agents is the opt-in.** The agent account stays off the
  control-plane rows of `CODEOWNERS`. The hand-check, `plan approve`, `decision rule` and the
  control-plane approval then refuse it. The `pitch-approved:` comment and the `bet` row read write
  access, and an agent account that pushes branches has it, so those two still pass.
- **GitHub enforces one check itself.** A pull request's author cannot approve it. Where two or more
  control-plane owners exist, the approval a control-plane pull request needs is a review from an
  owner account that did not author it.

**Binding constraints.**

- No new proof that a person acted is added to any owner-only step.
- No repo is required to run agents under a second account.
- A page, skill or message that describes an owner-only step never says an agent cannot satisfy it.

## Consequences

**A solo adopter reads what is true of their repo.** The guide no longer lets them believe a human
check exists where an agent's comment can pass it.

**The one-account repo keeps working with no setup.** Nothing new is asked of the common case.

**The separation is real only where someone sets it up.** A team that wants it creates the second
account and follows the how-to. Two steps stay open to that account, and the how-to says which.

**Making `pitch-approved:` and the `bet` row read the roster is a behaviour change.** It is not
ruled here, and a later record decides it if anyone asks.

## Records

- Transcribes the founder ruling on
  [#10363, comment 5974828047](https://github.com/kamp-us/phoenix/issues/10363#issuecomment-5974828047),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
- The explanation is in
  [`how-fabrika-works.md`](../claude-plugins/fabrika/guide/how-fabrika-works.md), and the how-to is
  [`run-agents-under-a-second-account.md`](../claude-plugins/fabrika/guide/run-agents-under-a-second-account.md).

Vocabulary impact: none coined.
