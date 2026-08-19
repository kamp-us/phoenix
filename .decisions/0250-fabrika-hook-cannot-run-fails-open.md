---
id: 0250
title: a fabrika hook whose verb cannot run fails open, and the silence is what is banned
status: accepted
date: 2026-08-09
tags: [fabrika, hooks, guards, probes]
---

# 0250 — a fabrika hook whose verb cannot run fails open, and the silence is what is banned

**What this decides:** the polarity of exactly one state — a fabrika hook fires, and its verb
**never ran** (a bare `fabrika` exits `127` on a machine with no install; a cross-checkout
invocation refuses with exit `126`). That state **fails open**: the harness event proceeds. What
this decision adds on top of the v1 status quo is that **fail-open-and-silent is banned** — the
cannot-run state owes a visible degraded notice, and this ADR records that the notice does not
have a working home today.

This rules the **cannot-run** case only. A verb that **runs** and returns a deny still fails
closed exactly as designed — `fabrika hook spawn` denying an off-allowlist model
([`../packages/fabrika-cli/src/hook/spawn.ts`](../packages/fabrika-cli/src/hook/spawn.ts), ADR
[0092](0092-gates-fail-closed-on-zero-scope.md)) is untouched. Nothing here weakens a gate that
executed.

Ruled by the founder seat on [#5079](https://github.com/kamp-us/phoenix/issues/5079)
(comment `5234582663`), the one founder-seat question inside epic
[#4927](https://github.com/kamp-us/phoenix/issues/4927).

## Context — the fork, with both horns intact

### Horn A — fail open, because it is a deliberate hard invariant in v1

v1's `../claude-plugins/kampus-pipeline/hooks/guard.sh`
L25–34 carries an explicit **`#1050` FAIL-OPEN INVARIANT (HARD)**: when the CLI is absent — not yet
installed, a degraded/offline install, or a hook firing with a stripped PATH before SessionStart
completes — the wrapper **must** consume stdin and exit 0, never abort the hook or the spawn. The
property it buys is that **one lane's fault never wedges the whole pipeline**, and the incident
behind it is real: [#787](https://github.com/kamp-us/phoenix/issues/787) /
[#788](https://github.com/kamp-us/phoenix/issues/788) /
[#789](https://github.com/kamp-us/phoenix/issues/789), a stripped-PATH hook failure that took down
worktree spawns for **every lane at once**.

### Horn B — fail closed on the proven-unsafe state, because a silent no-op reads as coverage

A guard that no-ops silently is indistinguishable, from the outside, from a guard that ran and
allowed. The v1 record has both failure shapes. The **stale-build** case:
[#3742](https://github.com/kamp-us/phoenix/issues/3742) — an executability test dispatched a
months-old binary carrying zero copies of the isolation guard, for months, while the isolation
defence read as armed. The **masking** case: an adjacent layer refusing loudly next door made an
inert guard look armed. Horn B is never a blanket fail-closed; it refuses only on a state proven
unsafe and stays open on ambiguity, which is the same rule as
[`../.patterns/liveness-probe-outcomes.md`](../.patterns/liveness-probe-outcomes.md)'s.

Both horns are real. This ADR rules the fork without collapsing either.

## Two things checked first-hand, because the epic body carried a stale reading

**1. `#3743` was closed as `not_planned`, never ruled.** Read live from the API this run:
[#3743](https://github.com/kamp-us/phoenix/issues/3743) ("Decide: should the worktree-isolation
guard fail closed?") is `state=closed`, `state_reason=not_planned`, closed `2026-08-01T18:30:26Z` —
swept in the v1 backlog kill batch as superseded by the fabrika rebuild. `guard.sh` L32 still
describes it as "an open founder ruling"; **that header is stale.** So this question arrives at
fabrika genuinely unanswered, and this is a fresh ruling against fabrika architecture, not a
revival of #3743. (`guard.sh` is v1 and frozen — ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md) — so this ADR does not edit that header.)

**2. The shared `.git/hooks` blast radius does not reach fabrika's hook surface — Horn A loses its
strongest support.** The #787–#789 blast radius is a property of a **git** hook: `.git/hooks` is
shared across every linked worktree, and `git worktree add` execs hooks with a stripped PATH, so
one failing hook aborts worktree creation for the whole crew
(`../claude-plugins/kampus-pipeline/hooks/create-worktree.sh`
L52–55 states exactly that). fabrika ships **no git hook**: a repo-wide grep for `.git/hooks` finds
zero hits under `claude-plugins/fabrika/`, and everything fabrika declares lives in
[`../claude-plugins/fabrika/hooks.json`](../claude-plugins/fabrika/hooks.json) as **Claude Code
harness** hooks — one `SessionStart` and one `PreToolUse`, per-session, not per-worktree. v1's own
`guard.sh` header cites the `.git/hooks` radius for what is likewise a harness hook, so the v1
rationale conflated the two surfaces; fabrika does not inherit that premise.

Horn A therefore survives on **different** grounds, and they are stronger for fabrika than the one
it lost:

- **Bootstrap deadlock.** Exit `127` means fabrika is not installed. A `SessionStart` hook that
  failed closed there would brick every session in a checkout without fabrika on PATH — including
  the session you would need in order to install it. A session must be able to *run* to install
  the thing the hook wants.
- **There is nowhere to fail closed *from*.** fabrika admits exactly one hook command shape, a
  plain literal `fabrika <group> <verb>` with no wrapper script
  ([`../claude-plugins/fabrika/docs/cli-interface-convention.md`](../claude-plugins/fabrika/docs/cli-interface-convention.md)
  rule 5, ADR [0232](0232-agents-execute-skill-scripts-never-source-them.md)). A process that never
  started emits no permission decision, and there is no interception layer to turn its absence into
  a deny. Implementing the fail-closed horn would mean minting the wrapper rule 5 forbids.

## The discriminator — two families with opposite safe answers

"Could not execute" resolves in **opposite directions** depending on which family the check belongs
to, and collapsing them produces a confident wrong answer either way.

- **Verification guard — unreadable input fails CLOSED.** The check *runs*, is the authority for
  the decision, and finds its input unreadable. `pipeline-cli checks read --expect green` is the
  canonical instance: exit `1` is read-OK-but-not-green (definite), exit `2` is UNREADABLE, and
  they are deliberately distinct — "'I could not read this head' must be distinguishable from 'I
  read it and it isn't what you expected', and neither may be mistaken for green"
  (`../packages/pipeline-cli/src/tools/checks/command.ts`
  L19–22, [#3999](https://github.com/kamp-us/phoenix/issues/3999)). Refusing here costs one stalled
  PR — recoverable, visible, and cheaper than a wrong merge.
- **Liveness probe — unrunnable resolves to UNKNOWN, never "down".**
  [`liveness-probe-outcomes.md`](../.patterns/liveness-probe-outcomes.md)'s three-outcome rule: only
  a probe that *actually ran* and observed the target unhealthy may gate; a missing binary, a
  stripped PATH or an exec error carries no information about the target.
  [#3411](https://github.com/kamp-us/phoenix/issues/3411) is the cost of getting this backwards — a
  bare `timeout` that was not on PATH read as "API down" and baked a conductor idle for ~5 hours
  while the API was fine.

**The fabrika cannot-run state belongs to the second family, and the reason is about evidence, not
about consequences.** The distinction that decides it is *which thing failed*: a verification guard
that fails closed has **run** and is holding a decision it is the authority for; a fabrika hook whose
verb never started has produced **no evidence at all**. A deny there would be asserting a violation
nobody observed — the #3411 error exactly. So the cannot-run state may not deny.

What does **not** follow is that it may pass. The honest resolution is the third outcome:
**UNKNOWN, announced**. The event proceeds, and the degraded state is said out loud.

## The decision

1. **A fabrika hook whose verb cannot run fails OPEN.** The harness event proceeds; the hook never
   converts a cannot-run into a deny. The interim line seated by
   [#5074](https://github.com/kamp-us/phoenix/issues/5074) is **confirmed as the permanent
   polarity**.
2. **Silence is the banned state.** Fail-open-and-loud, never fail-open-and-forgotten. The
   cannot-run state owes a visible degraded notice on stderr saying that the hook did not run and
   which defence is therefore absent.
3. **The boundary holds.** A verb that ran and denied still denies.

### Which states are proven-unsafe, and which are UNKNOWN

**No cannot-run state is proven-unsafe**, and that is the whole content of the ruling. Both exits
the convention reserves for "the verb never ran" resolve UNKNOWN
([`cli-interface-convention.md`](../claude-plugins/fabrika/docs/cli-interface-convention.md) rule 3):

| State | Reading | Gates? |
| --- | --- | --- |
| exit `127` — nothing on PATH | UNKNOWN, and the notice cannot come from fabrika (see below) | no |
| exit `126` — cross-checkout refusal | UNKNOWN, and fabrika itself speaks the refusal | no |
| ran, returned a deny | a real verdict on observed input | **yes — fails closed** |
| ran, returned allow / no objection | a real verdict | no |

> **Amendment, 2026-08-13 ([#5423](https://github.com/kamp-us/phoenix/issues/5423)) — the exit-2 row's
> factual reading was wrong, and the fix is a re-seat rather than a re-ruling.** The row above read
> `exit 2 — cross-checkout refusal … Gates? no`. On `PreToolUse` that "no" was false: exit `2` is
> the *one* code the harness reads as "block the tool call", verified first-party against the
> installed build (2.1.228 `strings`, *Before tool execution*) and live on 2.1.227 (a probe hook on
> matcher `Task|Workflow` exiting `2` stopped an agent spawn; the same probe exiting `3` did not).
> So while fabrika's bootstrap failures sat on `2`, a fabrika that could not resolve itself **denied
> every `Task`/`Workflow` spawn in the session** — the exact inverse of the polarity this ADR ruled.
> `SessionStart` was never exposed: exit `2` there is user-visible only.
>
> **The ruling is unchanged; only the premise was.** The cannot-run state still fails open, and no
> horn was re-decided. What changed is where the state sits: the founder ruling on #5423 (option A)
> moved fabrika's bootstrap/dispatch failures off `2` onto a non-blocking code, and `2` is now
> allocated by nothing in any fabrika exit table. The seat chosen is `126` rather than the ruling's
> illustrative `3`, because `3` is `EMPTY_STDIN` across the aligned tables and seating "I could not
> start" there would collapse it into "I started and read nothing"; `126` is the shell's own *found
> but not executable*, the same claim one level up, and it can never collide with a group's `3`+
> band. Four sites moved — `bin.ts`'s `ERR_MODULE_NOT_FOUND`, `delegate/entry.ts`'s foreign-checkout
> refusal and walk-fault, and `delegate/resolve.ts`'s spawn fault, the fourth found while fixing the
> three the issue named. The general rule now lives in
> [`../claude-plugins/fabrika/docs/hook-surface.md`](../claude-plugins/fabrika/docs/hook-surface.md)
> (*The harness exit-code contract*), and the polarity is pinned by a regression test rather than by
> this prose.
>
> **The adversarial review this ADR gates implementation on was discharged by the #5423 ruling**,
> which weighed proceeding-unguarded against a blocked spawn for both the dependency-not-linked and
> cross-checkout states and chose option A explicitly. The exposure it accepts is the one the
> Consequences below already name.

**UNKNOWN never drives a refusal.** A hook may only deny on a decision its verb actually computed
from input it actually read.

### The teeth have no home today — recorded, not papered over

The ruling names a visible degraded notice as the price of fail-open. Checked first-hand, that
notice is **implementable for one of the two states and not the other**:

- **exit `126`** — the process *did* start, so fabrika speaks for itself: the foreign-checkout refusal
  prints on stderr from
  [`../packages/fabrika-cli/src/delegate/resolve.ts`](../packages/fabrika-cli/src/delegate/resolve.ts)
  (the [#4956](https://github.com/kamp-us/phoenix/issues/4956) branch). This half already works.
- **exit `127`** — fabrika cannot speak, because fabrika is what failed to resolve. The shell emits
  `command not found` and nothing else. The seam the ruling points at —
  [#5078](https://github.com/kamp-us/phoenix/issues/5078)'s session-start degraded signal — is
  **closed with a RETIRE verdict**, read live this run: a fabrika session-start probe of "fabrika
  does not resolve" is itself a `fabrika` invocation, so it is silent in exactly the state it exists
  to report (the `spawn-guard freshness` record in
  [`../claude-plugins/fabrika/docs/hook-surface.md`](../claude-plugins/fabrika/docs/hook-surface.md)).
  **So the notice for the `127` state has no owner today.** Its only structural cure is the publish
  plus install at [#4791](https://github.com/kamp-us/phoenix/issues/4791), which removes the state
  rather than reporting it.

**UNKNOWN:** what Claude Code itself does when a *declared* hook's command is unresolvable — whether
the harness surfaces a hook-failure line of its own, or nothing. It could not be checked first-hand
(a `SessionStart` hook cannot be fired from inside a running session), and it is the difference
between "the notice is missing" and "the harness already provides one". This ADR does not claim
either.

### Implementation is gated on an adversarial review

Before the chosen horn is implemented — **in either direction** — an adversarial review /
threat-model is required. Tightening and loosening a guard both warrant one, and a code gate never
vets the security premise behind a guard change. This ADR is the ruling; it is not an
implementation licence.

### The single reversible policy point

The ruling lands in **exactly one place**: the *dispatch-failure policy point* section of
[`../claude-plugins/fabrika/docs/hook-surface.md`](../claude-plugins/fabrika/docs/hook-surface.md)
(anchor `#the-dispatch-failure-policy-point`). That section flips from "INTERIM, owned by #5079" to
"RULED, #5079", and it stays the one place a future ruling would flip. The behaviour must not be
spread to a per-verb site.

## Consequences

- **A machine where `fabrika` does not resolve runs every spawn with the model defence absent, and
  under the `127` state says so only through a shell `command not found`.** That is a real, named
  exposure, not a discharged one; it is what #4791 closes.
- **fabrika's hook surface must never grow an interception wrapper to implement a deny-on-cannot-run.**
  That shape is forbidden by rule 5 and would reintroduce the v1 apparatus fabrika deleted.
- **A future hook that is a git hook would re-open the blast-radius question.** This ADR's finding is
  scoped to the harness hooks fabrika declares today; a fabrika artifact installed into `.git/hooks`
  inherits the #787–#789 radius and gets its own record.
