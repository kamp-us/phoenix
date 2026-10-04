---
id: 0463
title: Shared skill text states the plain rule first and names the harness beside its knob
status: accepted
date: 2026-10-04
tags: [fabrika, skills, harness, conventions]
---

# 0463 — Shared skill text states the plain rule first and names the harness beside its knob

**What this decides:** when a fabrika skill tells the reader to use a control that only one harness
has, it first says the rule in words every harness can follow, then names that harness next to the
control.

## Context

[ADR 0367](0367-codex-is-a-supported-harness.md) admits Codex alongside Claude Code and pi and binds
"Shared skills remain the stage contract". One skill text is read on all three.

The `review` skill's CI-wait step told the reader to set "the Bash tool's own `timeout`", with its
`600000` ms ceiling and the `BASH_MAX_TIMEOUT_MS` escape. Those are Claude Code's. A Codex or pi
shell reading the step finds a control with a different name, or none.
[#9104](https://github.com/kamp-us/phoenix/issues/9104) filed that, and noted the fabrika skill
conventions carried no rule for it, so each author decided per sentence. A second copy of the same
paragraph was already queued for the `ship` skill
([#9103](https://github.com/kamp-us/phoenix/issues/9103)).

[ADR 0379](0379-audit-selection-through-conversation.md) is adjacent and does not cover this. It
rules that the architecture audit uses its current harness's native tools and never launches another
harness. This record is about the other direction: shared prose naming one harness's control.

#9104 put three options to the founder: write the shape down as a convention and sweep the corpus,
reword `review` only, or leave it. The ruling is recorded on
[#9104, comment 5625299764](https://github.com/kamp-us/phoenix/issues/9104#issuecomment-5625299764),
2026-09-10, by an EA session on the founder's behalf. The question it put and the answer:

> Asked: Should shared skill text always state the plain rule first and name the tool when it names
> that tool's knob, written down once as a convention?
>
> Ruled: the recommended answer stands — yes.

This record is that ruling written down, per
[ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

## Decision

**Shared skill text states the plain rule first, and names the harness whenever it names that
harness's knob.**

- **The rule lives once, in the conventions.** Its home is
  [`skill-conventions.md` §16](../claude-plugins/fabrika/docs/skill-conventions.md#the-plain-rule-first-then-the-harness-beside-its-knob).
  A skill follows it and does not restate it.
- **The shape is rule, then instance.** The harness-free rule comes first. The harness-named
  instance follows, and carries every number that belongs to the knob.
- **The unit is the instance, not the sentence.** The instance opens by naming its harness once, and
  that naming covers every knob in it. The ruling's words do not pick a unit. The convention picks
  this one so a paragraph-long instance does not repeat the harness in every sentence.
- **The corpus is swept once against it.** The `review` CI-wait paragraph and its contract are
  reworded, and every other hit under the fabrika skills tree is reworded or listed with why it
  stays. Both lists are under [The sweep](#the-sweep) below.

The ruling does not say what counts as a knob beyond the question's own words. The convention reads
it as a control the step tells the reader to operate. Text that only describes what a harness does,
with nothing for the reader to set, is not ruled here.

## The sweep

Swept on 2026-10-04: every file under `claude-plugins/fabrika/skills/`. A hit is a control one
harness owns: a tool, a tool parameter, a spawn flag, a typed command, an environment variable, a
config key, a frontmatter field. This is a dated reading. Later text answers to the convention, not
to this list.

Reworded:

| Where | What |
|---|---|
| `review/SKILL.md`, `review/contract.md` (`review ci`) | Bash tool `timeout`, `600000`, `BASH_MAX_TIMEOUT_MS` |
| `ship/SKILL.md` (exit 33), `ship/contract.md` (`ship scope` prose, grounding note) | `isolation: worktree` |
| `operate/SKILL.md` (`verdict-owed` hand route, step 2) | `isolation: worktree` |
| `build/SKILL.md` (denied tool call) | `Edit`, the classifier, a permission rule |
| `build/SKILL.md` (rendered-visual stop note) | `/fabrika:operate <n>`, the command a person types |
| `build-ui/SKILL.md` (exit 12) | `/fabrika:front-door`, the command a person types |
| `front-door/contract.md` (roster resolution, rung 2) | `$CLAUDE_PLUGIN_ROOT`: "the harness" that sets it is now named |

Stays:

| Where | What | Why it stays |
|---|---|---|
| `ship/contract.md` refusal row and example | `isolation: worktree` | Quotes `ship scope`'s output byte for byte. The string is CLI source, filed as [#10463](https://github.com/kamp-us/phoenix/issues/10463) |
| `operate/SKILL.md` spawn and wait steps, `operate/contract.md` dispatch | `isolation: worktree`, the Agent tool, `lane dispatch --harness codex` | Already written "On Claude … On Codex …" |
| `operate/SKILL.md` (`verdict-owed` hand route, step 2) | `/fabrika:review <pr>`, `/fabrika:review-ui <pr>`, `/fabrika:governance <pr>` as the spawn prompt | Inside the step-2 instance that opens "on Claude", and the paragraph under it says step 2 is a Claude spawn |
| `front-door/SKILL.md`, `front-door/contract.md` | `disable-model-invocation`, `enabledPlugins`, the plugin cache | Already names Claude Code and Codex beside each |
| `build-ui/contract.md` refusal rows | `/fabrika:front-door` | Already says "in Claude Code" |
| `front-door/contract.md` roster output; `triage`, `review`, `governance`, `ship`, `heal-ci` contracts; the trigger phrases in skill descriptions | `/fabrika:<name>` and `/<name>` as the name a skill is reached by | States the skill's name, or quotes what a person says. No step tells the reader to type it |
| the contracts of `build`, `campaign`, `check-epic-plan`, `front-door`, `governance`, `heal-ci`, `plan-epic`, `report`, `review`, `ship`, `triage` | `$CLAUDE_PIPELINE_REPO` | Fabrika's own variable, read by its verbs on every harness. The name says Claude and no harness owns it |
| `skill-doctor/**` | per-harness collectors, homes and flags | Every one is named by harness; mostly imported upstream text |
| session-id chain in `build`, `check-epic-plan`, `handoff`, `heal-ci`, `operate`, `report`, `review`, `triage`, `wayfinding` | `CLAUDE_CODE_SESSION_ID`, `PI_SUBAGENT_PARENT_SESSION` | The neutral `FABRIKA_SESSION_ID` comes first and each variable's name carries its harness |
| `report/contract.md` | `$ANTHROPIC_MODEL`, `$CLAUDE_MODEL`, the user-level Claude config files | Names carry their harness; the reader sets none of them |
| `.claude/…` paths in `front-door`, `governance`, `review`, `operate`, `build`, `triage` contracts | config and worktree paths | The path carries the harness; these are what a verb reads or writes, not a step for the reader |
| frontmatter of every skill that takes a number; `review/rubrics/skill.md`; `architecture-audit/contract.md` | `arguments:`, `argument-hint:` | Machine-read frontmatter owned by `skill-conventions.md` §4 and §12. The blank-number paragraph in each of those skills carries the harness-free step |
| frontmatter of `build`, `build-ui`, `review`, `review-ui`, `heal-ci`; prose in `governance`, `write-pattern`, `architecture-audit` | `context: fork`, `background: true` | Machine-read frontmatter owned by `skill-conventions.md` §13, which names the Claude Code build it was read from |
| the blank-number paragraph in `build`, `build-ui`, `review`, `review-ui`, `ship`, `triage`, `plan-epic`, `check-epic-plan`, `heal-ci`, `governance`, `operate` | `skills:` frontmatter preload | Explains where a blank comes from. The step itself (take the number from the brief) is harness-free |
| `build`, `review`, `report`, `heal-ci` skills; `governance`, `report` contracts; `review/rubrics/skill.md` | the worktree-isolation verifier | Describes a refusal the reader meets, with nothing to set. `skill-conventions.md` §4 owns it |
| `build`, `build-ui`, `review`, `triage`, `operate` | the session scratchpad | Named as the hazard; the step is the `scratch` verb |
| `writing-for-agents/SKILL.md`, `test-audit`, `adr`, `review/rubrics` | `CLAUDE.md`, `AGENTS.md` | File names, and `writing-for-agents` is imported verbatim |

## Consequences

**A reader on any harness can finish the step.** The plain rule is enough to act on, and a named
instance tells the other readers it is not theirs.

**#9103 copies the new shape.** Whatever mirrors the CI-wait paragraph into `ship` mirrors the rule
and the Claude Code instance, not the bare knob.

**A new harness adds instances, not rules.** Admitting one means writing its instance where a step
has one, once someone has run the step there.

**One verb's refusal text still names the knob bare.** `ship scope`'s exit-`33` line says
`isolation: worktree` with no harness. That string is CLI source, outside the skill text this sweep
covers, and is filed as [#10463](https://github.com/kamp-us/phoenix/issues/10463).

## Records

- Source: [#9104](https://github.com/kamp-us/phoenix/issues/9104) and its ruling comment.
- No vocabulary impact.
