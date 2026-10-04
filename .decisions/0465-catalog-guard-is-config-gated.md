---
id: 0465
title: A .fabrika.jsonc key turns catalog-guard on or off per repo, never the guard's own tree probe
status: accepted
date: 2026-10-04
tags: [fabrika, cli, pipeline, gates, build, config]
---

# 0465 — A .fabrika.jsonc key turns catalog-guard on or off per repo, never the guard's own tree probe

**What this decides:** a repo that does not use a pnpm catalog turns `catalog-guard` off with one
config key, and the guard's failure message tells it which key.

## Context

`catalog-guard` enforces a phoenix convention: every dependency comes from the pnpm `catalog:` or a
`workspace:` reference. ADR [0381](0381-local-tree-guards-run-in-build-check.md) made it a
local-tree guard, so `fabrika build check` runs it on every surface in every repo that installs
fabrika.

An adopter repo that never adopted `catalog:` reds on it every time.
[#9639](https://github.com/kamp-us/phoenix/issues/9639) reports 283 dependencies across 48
manifests, all older than the lane and none in its diff. The sweep stops at the first red, so the
repo's own `codeValidators` never run, and every code lane there discloses a bypass and runs its
gate by hand.

ADR 0381 gave that repo no way out. Its last binding constraint reads: "Membership lives beside the
guard's registration and nowhere else. A second list — in a config file, a workflow, or a skill — is
the drift this record exists to prevent." Its consequences name "the guard's own scoping" as the
only remedy for a guard that is wrong for a repo.

The founder ruled on #9639 on 2026-09-26, at the weekly table. The question put to him was whether
the guard should turn itself off or be a config value. His answer, verbatim
([ruling comment](https://github.com/kamp-us/phoenix/issues/9639#issuecomment-5852554214)):

> let's just gate this via a config, that's just simpler. with good error messages that explains the problem.

That comment replaces an
[earlier ruling](https://github.com/kamp-us/phoenix/issues/9639#issuecomment-5852547034) posted a
minute before it, which had the guard skip itself when the workspace declares no catalog. This
record transcribes the later one, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). It amends ADR 0381 in part.

The quote is the founder's. The ruling comment's gloss on it supplies the three things the message
carries and the scope "for this guard". The default below is this record's proposal, which the
ruling asked the builder to make. It is not his words.

## Decision

**A `.fabrika.jsonc` key turns `catalog-guard` on or off per repo, and the guard's failure message
names that key.**

- **The key is the gate.** A repo that sets it off does not have `catalog-guard` judge its tree.
  The guard does not probe `pnpm-workspace.yaml` to decide for itself whether the rule applies.
  The key lives in the tracked file: ADR [0398](0398-machine-local-config-layer.md) already keeps
  it out of the machine-local layer.
- **The failure message carries three things:** what the rule is, that this repo may simply not use
  a catalog, and which config key turns the guard off.
- **Proposed default: on.** The ruling did not state one and left it to the builder to propose. On
  keeps phoenix as it is, and it is the only default under which an adopter ever sees the message
  the ruling asks for. An adopter pays one red and one config line.
- **This amends ADR 0381 for this guard only.** `catalog-guard` stays a declared member of the
  local-tree set, beside its registration. The key answers whether this repo runs it. ADR 0381's
  "no second list" constraint holds for every other guard.

**Not ruled.** The issue asked two more questions, and the ruling answers neither. This record does
not answer them either, and behaviour on `main` stays as it is.

- **Whether the sweep keeps going past the first red guard.** It stops at the first red today
  ([`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts)).
- **Whether `readme-guard` is covered.** The ruling names `catalog-guard` alone. `readme-guard`'s
  adopter red ([#9455](https://github.com/kamp-us/phoenix/issues/9455)) was fixed separately by
  [PR #9877](https://github.com/kamp-us/phoenix/pull/9877), which narrows that guard to the diff's
  changed paths and adds no config key.

**Binding constraints.**

- The key covers `catalog-guard` and nothing else. A general per-repo guard list is not ruled, and
  a second guard needs its own ruling.
- A red from `catalog-guard` never prints without the key that turns it off.

## Consequences

An adopter repo without a catalog gets a green `build check` after one config line, and its own
validators run again.

The local check now has a second place that decides whether one guard runs: the registration says
it is a member, the repo's config says whether it runs. That is the drift ADR 0381 warned about,
taken on purpose for one guard because a config value is simpler than teaching the guard to read
the tree.

A repo can turn the guard off while it does use a catalog. That is the repo's choice, per ADR
[0430](0430-fabrika-helps-never-polices-choices.md).

The ruling does not say how a guard that is turned off shows in `build check`'s answer, or what the
CI leaf exits in that repo. Both are settled in the build.

## Records

The build work is [#10477](https://github.com/kamp-us/phoenix/issues/10477): add the key, have the
guard read it, and rewrite the failure message. The key's name is that build's to pick.

Sources: the ruling at
[#9639, comment 5852554214](https://github.com/kamp-us/phoenix/issues/9639#issuecomment-5852554214);
ADRs [0381](0381-local-tree-guards-run-in-build-check.md),
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md),
[0398](0398-machine-local-config-layer.md) and
[0430](0430-fabrika-helps-never-polices-choices.md);
[`packages/fabrika-cli/src/guard/catalog.ts`](../packages/fabrika-cli/src/guard/catalog.ts),
[`packages/fabrika-cli/src/guard/catalog-verb.ts`](../packages/fabrika-cli/src/guard/catalog-verb.ts),
[`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts).

## Amendments

- **#9639 — the default is ruled on, and the sweep question is answered (2026-10-04).** The founder
  answered two questions on the rulings desk
  ([ruling comment](https://github.com/kamp-us/phoenix/issues/9639#issuecomment-5983099465)). Asked
  whether the check should be on by default, so an adopter turns it off with one config line, he
  picked "Yes, on by default". The default above is now his ruling, not this record's proposal.
  Asked whether the sweep should keep going past a red guard, he picked "Yes, keep going". ADR
  [0468](0468-guard-sweep-reports-every-red.md) records that answer, so the first bullet under
  "Not ruled" no longer holds. The second one does: nobody asked whether `readme-guard` is covered,
  and no ruling answers it.
