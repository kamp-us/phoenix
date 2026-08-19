---
id: 0237
title: Agent brevity binds messages to humans; board artifacts stay complete evidence
status: accepted
date: 2026-08-01
tags: [pipeline, docs, agent-output, claude-md]
---

# 0237 — Agent brevity binds messages to humans; board artifacts stay complete evidence

**What this decides:** An agent's messages to a person must be concise, bulleted, and free of
AI-tell jargon — but board artifacts (issue bodies, PR descriptions, review verdicts, epic
ledgers, ADR and pattern bodies, commit messages) are exempt and keep the existing prose rules.
"No AI jargon" means the AI-tell catalog, so the repo's house idioms stay legal. `CLAUDE.md`
states the message rule and points at the writing skill for the artifact half.

## Context

The founder gave a standing directive twice in one session: concise, only enough information, no
AI jargon, bullet points, essentials only. The second statement came right after an agent drifted
back into long prose. The stated reason is that long output overwhelms the reader, so a message
too long to absorb has not been delivered — the work behind it is lost at the last inch. This is
an accessibility constraint on the output surface, not a style preference, and it holds regardless
of who is reading.

Nothing in the repo recorded it. `CLAUDE.md`, `.patterns/` and `.glossary/` carry no rule on
message length, structure, or jargon. The nearest sibling is CLAUDE.md's "Comments earn their
place or die" — the same instinct applied to code comments, and itself the subject of ADR
[0119](0119-comment-discipline-is-an-independent-review-criterion.md).

Authored prose is already governed.
`writing-clearly-and-concisely`
carries Strunk plus an AI-tell catalog at
`references/ai-writing-tropes.md`;
`review-doc` scores it as a gate
criterion and `write-code`'s doc path reads it before generating prose. Its declared scope is
English prose artifacts: docs, ADR and pattern bodies, PR descriptions, issue bodies, progress
comments, commit messages. The gap is therefore narrow — the artifact half is covered and
enforced, while messages to a human are ungoverned.

Three questions had to be settled before any edit was safe (#4694), and one of them was a live
contradiction: the proposed wording *"no coined labels: say the literal thing"* reads as a ban on
exactly the vocabulary the same writing skill exempts (`§CP`, `Fixes #N`, `fail-closed`, the
progress-comment headers, ADR frontmatter, the `.glossary/` defined terms) and the pipeline runs
on.

## Decision

**Concise, bulleted, jargon-free binds an agent's messages to a human; board artifacts stay
complete evidence under `writing-clearly-and-concisely`, and `CLAUDE.md` states the message rule
while pointing at the skill for the artifact half.**

**1. "No AI jargon" means the AI-tell vocabulary. House idioms are exempt.** The ban is scoped to
the catalog in
`references/ai-writing-tropes.md`
— magic adverbs, `delve`/`leverage`/`utilize`, negative parallelism, empty transitions, false
suspense — and never to coined labels generally. `§CP`, `Fixes #N`, `fail-closed`, the
`Completed / Decisions / Gotchas / Next` headers, ADR frontmatter, and the `.glossary/` defined
terms remain established vocabulary, exactly as the writing skill already says. The line: a term
carrying meaning the team agreed on is doing work; a term performing sophistication is not. The
literal reading would have put `CLAUDE.md` in conflict with a rule the review gates already
enforce, and would have banned the labels the pipeline is built on.

**2. The brevity rule binds messages to humans only.** Chat and relay output written for a person
to read is bound. Board artifacts are not: issue bodies, PR descriptions, review verdicts, epic
ledgers, ADR and pattern bodies, and commit messages stay governed by
`writing-clearly-and-concisely`, which already covers them.

The load-bearing distinction: **artifacts are pull, messages are push.** A reader chooses to open
an issue and can stop; a message arrives whether or not there is room for it. An artifact is
evidence and is meant to be complete, so an over-broad reading would gut review verdicts and epic
plans — the surfaces the pipeline's gates depend on being thorough.

**3. `CLAUDE.md` states the message rule and points for the prose half.** A short `## Conventions`
entry states the messages-to-humans rule, which has no other home, and points at
`writing-clearly-and-concisely` for artifacts. It does not restate the prose rule. `CLAUDE.md`
already handles `.patterns/`, `.glossary/` and `.decisions/` by pointing rather than restating,
and two sources for one convention is the drift this repo bans elsewhere. Exactly one source owns
each half.

**Binding constraints.**
- A message to a human leads with the finding and its consequence, in bullets, and leaves the
  derivation in the artifact it came from.
- The artifact is the durable record; the message is a pointer to it, never a second copy.
- Length is a defect on the message surface and is not one on the artifact surface.
- The AI-tell catalog binds both surfaces; on the artifact side it already did.

**Banned.**
- Reading "no AI jargon" as a ban on house idioms or `.glossary/` terms.
- Trimming a review verdict, epic plan, issue body, or ADR for brevity under this rule.
- A second copy of the prose rule in `CLAUDE.md`.

## Consequences

This ADR **extends** `writing-clearly-and-concisely` rather than superseding it: that skill keeps
the artifact half unchanged, and this decision adds the messages half plus the boundary between
them. `review-doc`'s gate criteria do not change, and no existing prose is rewritten in bulk.

The `CLAUDE.md` edit is downstream follow-up work, not part of this decision's record.

**A downstream sequencing note, now historical.** When this was ruled on 2026-08-01 the plan was
#4694 upstream, #4690 downstream: `claude-plugins/pipeline-crew/` was repo-agnostic shipped content
(ADR [0062](0062-repo-as-config-plugin.md)), so a crew installed against a different repo never read
*this* repo's `CLAUDE.md`, and #4690 was to decide where the wording bound for the crew — as fixed
def doctrine or as a tunable key in that plugin's `PERSONALIZATION.md`. That surface no longer
exists. ADR [0279](0279-v1-crew-retired-in-full.md) retired the v1 crew in full and the
`claude-plugins/pipeline-crew/` tree, `PERSONALIZATION.md` included, was deleted; #4690 is closed.
The coverage gap and that open sub-question went with the crew. The wording stays single-sourced
here, and any later surface that ships agent definitions to another repo cites this ADR for it.

Control-plane approval is CODEOWNERS' call at the merge gate (ADR
[0053](0053-control-plane-boundary.md)), and it is not blanket over `claude-plugins/**`: ADR
[0274](0274-fabrika-tree-is-not-control-plane.md) rules `claude-plugins/fabrika/**` out of the
human gate in favour of a required `governance` verdict. What CODEOWNERS gates under
`claude-plugins/` today is the v1 tree — `kampus-pipeline/`'s `skills/`, `agents/`, `lib/`,
`hooks/` and `hooks.json`. A `CLAUDE.md` edit is gated by neither.

## Records

- **Vocabulary impact — a coined pair, routed to the glossary as #4702.** This ADR coins **push
  surface / pull surface** for the two output scopes: a *push surface* is output that arrives at a
  human unbidden (chat, relays) and is bound by the brevity rule; a *pull surface* is an artifact
  a reader opens on purpose (issues, PRs, verdicts, ledgers, ADRs) and is bound by
  `writing-clearly-and-concisely` instead. Routed to `.glossary/TERMS.md` by report #4702 rather
  than added inline, so this PR stays purely additive.
- Discharges #4694's ruling criteria. #4694 stays **open** — the `CLAUDE.md` edit is the remaining
  work. #4690, the crew-facing half, closed with the crew (ADR 0279).
