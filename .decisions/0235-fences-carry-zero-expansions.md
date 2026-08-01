---
id: 0235
title: A fence carries zero expansions — everything dynamic lives inside the script
status: accepted
date: 2026-07-31
tags: [pipeline, skills, tooling, isolation, control-plane]
---

# 0235 — A fence carries zero expansions — everything dynamic lives inside the script

**What this decides:** A documented fenced command that a worktree-isolated agent pastes may
contain no shell expansion of any kind — no variables, no defaults, no command substitution;
anything dynamic (target-repo resolution first among it) happens inside the script the fence
invokes by literal path.

## Context

ADR [0232](0232-agents-execute-skill-scripts-never-source-them.md) settled how a
worktree-isolated agent invokes an extracted skill script: literal-path execution with a stdout
contract, never sourcing. It ruled on the `CLAUDE_PLUGIN_ROOT` idiom — a case where a literal
path exists as a drop-in substitute.

The refused class turned out wider than that idiom. The
[#4595 verdict](https://github.com/kamp-us/phoenix/issues/4595#issuecomment-5148304102)
(an 18-trial controlled matrix under confirmed worktree isolation) pinned three independent
refusal triggers, each sufficient alone: **(a)** the `${VAR:-default}` syntax itself, even on a
set variable; **(b)** expansion of any variable the verifier cannot statically resolve;
**(c)** `$(…)` command substitution — and established that the verifier inspects only the
top-level command line, never the scripts it invokes. The
[#4609 verdict](https://github.com/kamp-us/phoenix/issues/4609#issuecomment-5148599245)
(32 controls) added a fourth independent trigger: a shell-unquoted `{` with a quote character
inside its span — which reaches even inert heredoc payloads, so a JSON-bodied heredoc refuses
while the same JSON single-quoted runs.

[#4605](https://github.com/kamp-us/phoenix/issues/4605)'s verified census (at `main`
`32e66f24`): 38 fenced blocks across nine pipeline docs paste `gh api … $REPO` with `$REPO`
bound outside the block — all genuinely in the refused class, zero verifier-safe shapes among
them. The desk inventory
([one](https://github.com/kamp-us/phoenix/issues/4605#issuecomment-5148407014),
[two](https://github.com/kamp-us/phoenix/issues/4605#issuecomment-5148610456)) extended the
class beyond the census: the canonical `REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view …)}"`
preamble itself — ADR [0062](0062-repo-as-config-plugin.md) §1's fence-level form, triggers
(a)+(c) — stdout-contract captures (`VAR="$(bash ./…)"`, trigger (c)), and JSON/heredoc
composition (the fourth trigger). For `$REPO` no literal substitute exists without abandoning
repo-agnosticism, so no sanctioned fence shape existed for the class; the operational state was
agents hand-substituting literal repo names, silently bypassing ADR 0062 §1.

A founder ruling on #4605
([ruling comment](https://github.com/kamp-us/phoenix/issues/4605#issuecomment-5148984851))
settled it **in-repo** — explicitly declining to hang the fix on the upstream verifier — by
applying ADR 0232's logic uniformly to the whole class instead of minting a per-variable
exception.

This is recorded as a fresh ADR rather than an amendment to 0232: 0232's ruling stands whole —
its literal-path execution shape is precisely this rule's only surviving fence form — and
nothing in it is changed in part. This ADR universalizes it. The relay-family boundary is
likewise untouched: ADRs [0228](0228-scripts-relay-never-derive.md),
[0229](0229-mechanical-combination-is-relay.md),
[0231](0231-decision-computing-logic-becomes-a-verb.md) and
[0233](0233-decision-shell-enforcement-review-skill-criterion.md) rule what a script may
*compute*, and ADR [0230](0230-cycle-validators-follow-the-source-edge.md) how validators scan
the in-script source edge this rule leaves sanctioned; this ADR rules only what a *fence* may
contain — orthogonal axes, no overlap re-decided.

## Decision

**The sanctioned fence shape under worktree isolation carries zero expansions — no `${VAR}`, no
`${VAR:-default}`, no `$(…)`. A fence is a literal-path invocation (ADR
[0232](0232-agents-execute-skill-scripts-never-source-them.md)'s shape) and nothing else;
everything dynamic moves inside the script, which the verifier never parses.**

Mechanics of the ruling:

- **Everything dynamic lives in-script:** `$REPO` resolution (the ADR 0062 §1 preamble, in the
  script or the shared lib it sources), command substitutions, JSON payload composition,
  heredocs. The verifier judges only the top-level command line (#4595), so relocating the
  dynamism removes the refusal without touching the harness.
- **Repo-agnosticism survives because the *script* stays repo-agnostic.** ADR
  [0062](0062-repo-as-config-plugin.md) §1's resolution rule — `CLAUDE_PIPELINE_REPO` override,
  else derive from the working repo — is preserved verbatim; only its placement moves from the
  fence into the script. The fence-level `$REPO` idiom is retired; the 0062 property is
  explicitly **preserved, not retired further**.
- **Consuming a script's answer:** the agent reads the results off the Bash tool's returned
  stdout (ADR 0232's stdout contract). The top-level capture shape `VAR="$(bash ./…)"` is
  itself trigger (c) — it is not a sanctioned fence.
- **The fourth trigger is mooted at top level by the same rule:** brace-bearing dynamic
  payloads (JSON, heredocs) are composed inside scripts (e.g. a script-built file fed to
  `gh api --input`), so no per-trigger fence workaround is needed or documented.

**Binding constraints.**
- A documented fence contains no `$` expansion and no `$(…)` in any position — assignment,
  invocation, argument, sourcing, or heredoc body.
- Every dynamic value a fence needs is resolved by the script it invokes; new scripts follow
  ADR 0232's stdout contract and the shell shape in
  [`.patterns/skill-script-shell-shape.md`](../.patterns/skill-script-shell-shape.md).
- Scripts resolve the target repo per ADR 0062 §1 (in-script or via the shared lib); a plugin
  script never hardcodes the target repo.

**Banned.**
- Any top-level dynamic fence — including the `REPO=` resolution preamble as a fence, and the
  `VAR="$(…)"` stdout-capture shape.
- Hand-substituting a literal repo name into a documented plugin fence (the silent ADR 0062
  bypass this rule exists to end).
- Documenting a workaround convention for top-level dynamic fences — top-level dynamic fences
  are no longer a sanctioned shape, so there is nothing to sanction a workaround *for*.

**Application: prospective only.** The rule binds new and held work — it lands through the held
conversion lanes' acceptance criteria ([#4575](https://github.com/kamp-us/phoenix/issues/4575)'s
sweep, [#4576](https://github.com/kamp-us/phoenix/issues/4576)'s backstop, the residue lanes),
held precisely so a rule change lands without re-cutting finished work. It does **not** re-open
work already gated: a PR gated before this ADR stays judged under the rules in force at its head
— concretely, the six banked control-plane PRs of 2026-08-01, whose gates deliberately passed
main-identical residual expansion fences and routed the class to the ruling issue; that routing
was correct. A retroactive reading would supersede current-head verdicts and void granted
approvals via dismiss-stale-on-push, buying no safety: the residual fences are main-identical
and the sweep lanes own their removal. Grounding: the desk posture record
([#4605 comment](https://github.com/kamp-us/phoenix/issues/4605#issuecomment-5148997890)) and
the engine's hazard record
([#4605 comment](https://github.com/kamp-us/phoenix/issues/4605#issuecomment-5148992269)).

## Consequences

- **The ~38-fence `gh api $REPO` census converts to script-backed reads**, routed into the
  [#4435](https://github.com/kamp-us/phoenix/issues/4435) / ADR 0232 conversion programme
  alongside [#4575](https://github.com/kamp-us/phoenix/issues/4575)'s sweep. **Implementation
  is programme fan-out, not this ADR's scope** — this ADR's diff is the decision file alone.
- **[#4609](https://github.com/kamp-us/phoenix/issues/4609)'s exposure dissolves by the rule:**
  JSON is composed inside scripts, so no top-level workaround convention gets documented. Its
  boundary-pinning matrix stays valuable for the record as the fourth trigger's evidence base.
- **[#4576](https://github.com/kamp-us/phoenix/issues/4576)'s backstop disposition: widen to
  the class.** The final check reds on any fence expansion — position-blind, all four triggers'
  shapes, not the `CLAUDE_PLUGIN_ROOT` idiom alone — sequenced **rule → census → check**: the
  census of the remaining dynamic-fence population follows this ruling, and the check follows
  the census (the incidental-brace-in-prose population is unmeasured until then).
- **Upstream anthropics/claude-code#82966 is demoted to a courtesy tracking pointer only** — no
  in-repo work depends on it; the revisit trigger recorded on
  [#4558](https://github.com/kamp-us/phoenix/issues/4558) stands unchanged.
- ADR 0232's recorded plugin-portability trade extends unchanged in kind: fences hardcode
  literal in-repo script paths, and portability lives entirely in the scripts.

## Records

- Closes [#4605](https://github.com/kamp-us/phoenix/issues/4605).
- **Vocabulary impact — considered, none routed to the glossary.** *Fence* (a documented fenced
  command block an agent pastes at top level) and the numbered *refusal triggers* are
  pre-existing shorthand from the #4595/#4609 investigation record, not coined or redefined
  here; the ruling applies existing vocabulary to an existing class. Recorded outcome: no
  glossary entry.
