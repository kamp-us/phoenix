---
id: 0286
title: Standing lanes come from a repo's `.fabrika.jsonc` `lanes` key, never a CLI literal
status: accepted
date: 2026-08-17
tags: [fabrika, config, triage, plugin-portability, pipeline]
---

# 0286 — Standing lanes come from a repo's `.fabrika.jsonc` `lanes` key, never a CLI literal

**What this decides:** fabrika reads the list of standing lanes out of the repo's own `.fabrika.jsonc`. A repo that declares no lanes has none — `triage homes` offers none there and `triage apply --lane` accepts none — and phoenix declares its own two (`wayfinder:backlog`, `axis:pipeline-hardening`) in its own file.

## Context

Founder ruling, 2026-08-17, on issue [#5774](https://github.com/kamp-us/phoenix/issues/5774) ([the ruling comment](https://github.com/kamp-us/phoenix/issues/5774#issuecomment-5310884414)) — option 1 of the four on that issue.

`triage homes` exists to enumerate the real homes on *this* board, and its own docblock argues it offers only open, roadmap-joined milestones so that "a closed milestone reports as a valid home" cannot happen. It then appends two rows that come from neither the board nor the repo. The literal is `STANDING_LANES` at [`packages/fabrika-cli/src/triage/homes-verb.ts:39-42`](../packages/fabrika-cli/src/triage/homes-verb.ts), printed unconditionally whatever repo it runs against. `triage apply --lane` advertises the same pair off a second copy at [`packages/fabrika-cli/src/triage/facets.ts:28`](../packages/fabrika-cli/src/triage/facets.ts), and `build` scope-admission reads a third at [`packages/fabrika-cli/src/build/scope-admission.ts:40`](../packages/fabrika-cli/src/build/scope-admission.ts). None of those paths asks whether the label exists on the board.

Standing fabrika up in `kamp-us/demlik`, where neither label exists, showed what that costs: `homes` printed both lanes as assignable homes, `apply --help` advertised them, and taking either at its word failed one step later at a *different* verb citing a *different* missing label. The failure was late and misattributed instead of early and clear.

fabrika ships as an installed plugin (ADR [0273](0273-fabrika-ships-as-an-installed-plugin.md)), so every repo-specific value it carries is a value some other repo has to live with. Epic [#5631](https://github.com/kamp-us/phoenix/issues/5631) is already building the mechanism — one root `.fabrika.jsonc`, read by the CLI and nothing else — but it named lane eviction as a No-go, verbatim: *"Evicting the phoenix product literals … the `axis:pipeline-hardening` lane) is a separate un-ruled decision and is not carried here."* A builder could not pick a source without re-opening that boundary. This ADR is that ruling.

The wider principle the founder stated, verbatim: **"everything we use today can be default config but it should be configurable."** Today's compiled values become the shipped defaults of config keys, so a bare repo works without writing a file. Lane names are the pinned edge to that rule, ruled explicitly.

This **amends ADR [0208](0208-standing-lane-exemption-from-full-homing.md) in part.** Phoenix's set is unchanged — still exactly `wayfinder:backlog` and `axis:pipeline-hardening`, still exempt from milestone homing, and every ADR reading the set off 0208 stays true. What changes is where that set is written down: phoenix's own `.fabrika.jsonc`, not fabrika's source, and the set is phoenix's rather than every repo's.

## Decision

**Standing lanes are declared per repo in `.fabrika.jsonc` under a `lanes` key; the CLI carries no lane literal and ships no lane default.**

**Both lanes get the same answer.** `wayfinder:backlog` reads more generic than `axis:pipeline-hardening`, and that did not earn it a different rule. Both move to phoenix's `.fabrika.jsonc` together.

**An absent `lanes` key means zero standing lanes, not the phoenix pair.** This is the one place the "today's value becomes the default" principle does not apply: a lane name is board vocabulary, not a behaviour default. A default label name is a fiction the CLI asserts about someone else's board, and asserting it is exactly the demlik failure. Every other repo-specific value under [#5631](https://github.com/kamp-us/phoenix/issues/5631) still ships with today's value as its default — this exception is about names, not about configurability.

What each verb does in a repo declaring no lanes:

- **`triage homes`** offers no lane rows at all. Its milestone behaviour is untouched: zero open milestones stays a refusal, not an answer.
- **`triage apply --lane`** accepts no lane value there. Every `--lane` argument is refused against the declared set, so an undeclared lane is refused up front by `apply` itself rather than surfacing later as a missing-label error from a different guard.
- **`build` scope-admission** reads the same `lanes` key — the same source, not a separate concern and not a fourth copy. A repo declaring no lanes admits scope on milestone presence alone; the lane exemption of ADR [0208](0208-standing-lane-exemption-from-full-homing.md) exists only where a lane is declared.

**Relationship to epic [#5631](https://github.com/kamp-us/phoenix/issues/5631): its lane No-go is lifted and this work folds into that epic.** The lanes are threaded as a config key by the same mechanism, in the same epic, and not as separate work with its own home. The three-copy collapse is [#5785](https://github.com/kamp-us/phoenix/issues/5785) and is buildable ahead of the thread; one collapsed reader is what gets re-pointed at the config.

**Binding constraints.**

- No `packages/fabrika-cli/src/**` module may enumerate a lane label. The declared set is the only source, and a lane the config does not name does not exist to any verb.
- No shipped default fills an absent `lanes` key. An absent key and an empty list mean the same thing: zero lanes. This is deliberately *not* the "missing config resolves to defaults" rule #5631's loader applies elsewhere — that rule exists so an unread config cannot silently disable a gate, and zero lanes disables no gate.
- A lane value that is not in the declared set is refused before any write, by the verb that took it.
- Adding a third lane to phoenix stays a founder ruling (ADR [0208](0208-standing-lane-exemption-from-full-homing.md)); it is now a ruled edit to phoenix's `.fabrika.jsonc` rather than to fabrika's source.
- No CLI change lands under [#5774](https://github.com/kamp-us/phoenix/issues/5774) itself. The build follows this ruling inside #5631.

## Consequences

phoenix becomes an ordinary fabrika consumer on this surface: its two lanes are data in its own repo, which is where an outside reader would look for them. A repo adopting fabrika is offered exactly the homes its board has, and `homes` keeps the promise its docblock already makes about not reporting a home that is not real.

The cost is that a declared lane is a name the config asserts and the board may not carry yet — the pitch grammar can name a lane before someone creates the label. That mismatch was already possible with the compiled literals and is not made worse; it is a separate question from where the list is read.

`.fabrika.jsonc` is a governed path under #5631, so removing phoenix's lanes is a diff that owes a governance verdict rather than a silent edit.

## Records

- **No vocabulary impact.** `standing lane` is already defined by ADR [0208](0208-standing-lane-exemption-from-full-homing.md), and this ADR changes only where the set is read from.
- ADR [0208](0208-standing-lane-exemption-from-full-homing.md) status set to `amended-in-part by [0286]`; its body is untouched.
