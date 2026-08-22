---
id: 0333
title: Dark-ship detection stays in the fabrika CLI behind provider config keys, never a companion plugin
status: accepted
date: 2026-08-21
tags: [fabrika, ship, dark-ship, config]
---

# 0333 — Dark-ship detection stays in the fabrika CLI behind provider config keys, never a companion plugin

**What this decides:** fabrika's dark-ship flag detection keeps its home in the fabrika CLI and reads
repo-specific values from config keys instead of compiled-in phoenix constants — the
companion-plugin eviction floated by R14.1's second half is withdrawn.

This transcribes the founder ruling recorded on
[#6304](https://github.com/kamp-us/phoenix/issues/6304#issuecomment-5348745924) (2026-08-19). The
trail that collapsed the field to one question is that issue's body; this record adds only the
choice and its mechanics.

## Context

R14.1 ([#5603, comment 5304553879](https://github.com/kamp-us/phoenix/issues/5603#issuecomment-5304553879),
2026-08-15) asked where the boundary sits between fabrika and a deployment-aware companion plugin,
given two constraints pulling opposite ways: the deploy/release separation must be kept
([ADR 0083](0083-agents-deploy-humans-release.md)), but *"i also really dont want fabrika to come
with a dependency on a cf worker infra."* Its answer split in two halves. Half one — containment as
a config-defined vocabulary plus the release queue — is owned by
[#6300](https://github.com/kamp-us/phoenix/issues/6300) under epic #5631 and is not this record's
subject. Half two would evict all three ground-truth dark-ship signals from
`packages/fabrika-cli/src/ship/dark-ship.ts`, with `product-development-cycle.md` leaving alongside
them, into a companion plugin — resting on the provider shape the founder floated in the same
breath (`containment-cf` vs `containment-local`).

The eviction leaned on [#5647](https://github.com/kamp-us/phoenix/issues/5647), the extension-seam
charting epic: without a seam, a companion plugin has nowhere to plug in. The founder killed #5647
on 2026-08-19 ([closed not planned](https://github.com/kamp-us/phoenix/issues/5647)) — *"i dont
think we know enough to make sure it works"* — removing the eviction's premise rather than settling
its question. The next day's ruling picked the other arm of the tension: keep the mechanism,
generalize its inputs. Epic #5631's No-gos had named this exact surface *"a separate un-ruled
decision"* on 2026-08-15; the ruling postdates that exclusion and answers it.

## Decision

**Dark-ship flag detection stays in the fabrika CLI and becomes provider-configurable via config
keys; R14.1's companion-plugin eviction of it is withdrawn.**

- **What stays:** all three ground-truth signals in
  `packages/fabrika-cli/src/ship/dark-ship.ts` (registry-add, the body `Flag:` line, reused-flag
  detection), including the edge cases they guard. `product-development-cycle.md` stays at the repo
  root, and [ADR 0083](0083-agents-deploy-humans-release.md) §2's cycle-interpreter mechanism stays
  as written — §1's principle was never in question, so that ADR needs no edit.
- **What becomes configurable:** the phoenix constants — the flag registry path and declaration
  syntax — become config keys. Phoenix supplies its values; another repo adopting fabrika (the
  phoenix-everywhere campaign's whole point) supplies its own. Nothing compiles a Cloudflare
  dependency into fabrika, which answers R14.1's original objection without moving code out.
- **The provider axis is configuration, not packaging or plugins.** The floated
  `containment-cf` / `containment-local` split does not become separate packages, and no runtime
  plugin seam replaces the one #5647 would have built. Reopening either shape takes a fresh ruling
  superseding this record.
- **Banned:** evicting dark-ship flag detection or `product-development-cycle.md` from fabrika
  under this ruling.

### Follow-ups named here, performed elsewhere

- [#6416](https://github.com/kamp-us/phoenix/issues/6416) implements the provider-configurable
  direction: flag registry path and declaration syntax become config keys.
- Epic #5631's No-go still calls this surface un-ruled; amending it to point here is the remaining
  follow-up, so future readers are not pointed away from ruled work.

## Consequences

- Fabrika carries zero default deployment-infrastructure dependency; adoption becomes a config
  exercise, not a fork or a plugin install order question.
- The extension-seam question stays dead for this surface: configurable constants remove the need
  the seam answered. A future need for runtime-pluggable providers is a new decision, not an
  amendment of this one.
- Until the #5631 No-go amendment lands, that issue contradicts this record on this surface; this
  ADR is the later word.
- The implementation cost lands in #6416: config schema, defaults, validation, and keeping the
  three signals' detection behavior identical while their inputs move from constants to config.

## Records

No vocabulary impact. Dark-ship, containment, flag registry and the cycle doc all carry settled
meanings ([`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md)); this record moves none of them.
