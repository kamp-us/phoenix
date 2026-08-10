---
id: 0247
title: A contract spec's example value is derivable from the spec, or it is not printed
status: accepted
date: 2026-08-09
tags: [fabrika, tooling, decisions]
---

# 0247 — A contract spec's example value is derivable from the spec, or it is not printed

**What this decides:** A fabrika contract spec that shows a computed number in an example has to say
how that number is computed. If it will not say, it shows no number. `adr sweep`'s shipped ranking is
adopted as its spec rather than replaced.

## Context

fabrika's contract-spec format ([`cli-interface-convention.md`](../claude-plugins/fabrika/docs/cli-interface-convention.md)
Part 2) is what an authoring session emits and a `write-code` agent builds from with no access to the
session. Its completeness test was six checks, all of them *presence* tests: every flag has a
default, every code has a trigger, every error has a message, every stdout shape has an example.

The wave-0 pilot built six verbs from one spec ([#4725](https://github.com/kamp-us/phoenix/issues/4725) /
[#4731](https://github.com/kamp-us/phoenix/pull/4731)). Five needed essentially no judgment. `adr
sweep` was different: its whole ranking specification was one inventory cell ("deterministic — scan,
score, sort") and one grounding line ("a lexical/rarity score over decision-bearing text"), and it
printed two example scores anyway. What counts as decision-bearing text, the tokenizer, the
stopwords, the rarity denominator, the tie-break and the rounding were all unstated, and each of them
moves the number. The implementation scored the same corpus in the 70s–90s where the spec's examples
were in the teens, and neither was wrong, because there was nothing to be wrong against
([#4735](https://github.com/kamp-us/phoenix/issues/4735)).

The spec's author omitted nothing the format asked for — no section and no check asks for a
computation. That makes it a format defect, and seventeen further specs are due to be authored
against the same doc (epic [#4650](https://github.com/kamp-us/phoenix/issues/4650)), so the same hole
is available to every one of them.

## Decision

**A contract spec's completeness test gains a seventh check: every value an example prints is
derivable from the spec, and a verb emitting a computed value either specifies the computation or
prints no example value.**

Specifying the computation means all of it — the inputs, the weighting, the tie-break, the rounding —
at the precision at which two implementers reading only the spec produce the same digits. Where the
value also depends on data the spec does not carry, the example names data a reader can hold fixed, a
committed fixture rather than a live corpus that moves under it. A worked example that looks
verifiable and is not is worse than no example: a reader treats the number as a contract.

**`adr sweep`'s shipped ranking is ratified, not replaced.** The function in
[`packages/fabrika-cli/src/adr/sweep.ts`](../packages/fabrika-cli/src/adr/sweep.ts) was written down
into the spec verbatim rather than a second ranking being invented to displace it. It was the only
complete statement of the ranking that existed, it is already the behaviour every caller sees, and a
re-derivation would have re-opened a settled question to no benefit. From here the spec is the
contract and the implementation is the bug if they ever diverge.

## Consequences

Authoring a verb that scores, ranks or otherwise computes a number now costs the author the whole
function in prose. That is the cost the rule intends: it is the difference between a spec and a
sketch, and it is paid once per verb instead of once per implementer.

An example that binds a committed fixture stays reproducible for as long as the fixture is committed,
so a reviewer can re-run it. `adr sweep` gains such a corpus under its skill's fixtures; a live
`.decisions/` example would print numbers that are stale the next time a record lands.
