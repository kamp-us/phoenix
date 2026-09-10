---
id: 0363
title: Tuval feature flags live in the config file, never a flag service
status: amended-in-part by [0373](0373-a-program-row-flag-is-read-off-its-own-config-layer.md)
date: 2026-09-07
tags: [tuval, config, feature-flags]
---

# 0363 — Tuval feature flags live in the config file, never a flag service

**What this decides:** a Tuval feature flag is a key in the `features` block of
`.tuval/tuval.config.ts`, merged across the config layers at boot and handed to the page as one
generated module. Changing a flag means editing that file and restarting the desk. There is no
flag service, no remote or runtime toggle, and no per-user or per-viewer flag state.

This transcribes the founder ruling recorded on
[#8384, comment 5573677646](https://github.com/kamp-us/phoenix/issues/8384#issuecomment-5573677646)
(2026-09-07). His words: *"ok, keep it that simple."*

## Context

The first Tuval flag, `features.subagentList`, arrived with the subagent-view epic
[#8384](https://github.com/kamp-us/phoenix/issues/8384) as a plan-shape call: the repo's default
rule is that a user-facing change ships dark behind a default-off flag
([`product-development-cycle.md`](../product-development-cycle.md)), so the new subagent list
needed one. The flag was built the only way a Tuval flag could be built — as config — and the
founder then asked what kind of flags Tuval uses and whether they are file-based only. The ruling
above is his answer.

The question is worth a record because the repo's other answer points somewhere else. ADR
[0081](0081-feature-flag-substrate-cloudflare-flagship.md) fixes the substrate as Cloudflare
Flagship: server-side evaluation through a Worker binding, a React hook over the evaluated values,
and a flip performed by an infra-admin in a dashboard with no redeploy.
`product-development-cycle.md` names that dashboard flip as the release step, and ADR
[0083](0083-agents-deploy-humans-release.md) makes it the human half of deploy-versus-release.
Every part of that rests on a deployed Worker, and Tuval has none: it is a local app, carries no
`alchemy.run.ts`, and never deploys — that absence is the marker (ADR
[0345](0345-tuval-lives-under-apps.md)). Tuval runs on one operator's machine, from one
checked-out tree, against files that operator owns. So the capabilities Flagship exists to buy — a
redeploy-free kill switch, percentage rollout, per-user bucketing, a flip by someone who is not
holding the source — buy nothing here. The operator who would flip the flag is the operator
editing the file.

What already exists is enough. `apps/tuval/src/features.ts` holds `TuvalFeatures` and the all-off
record `featuresOff`; `apps/tuval/src/config.ts` states each flag as an optional key, so an absent
key means *this layer says nothing* rather than *off*, and the layers merge
`{...featuresOff, ...global, ...project}`. `apps/tuval/src/page/dev-server.ts` writes the resolved
record as the generated module `virtual:tuval/features`
([#8462](https://github.com/kamp-us/phoenix/pull/8462)), which the page's renderer table imports
before its first paint — the same boundary the module-renderer table already crosses (ADR
[0359](0359-tuval-window-renderer-is-a-module-specifier.md)).

## Decision

**A Tuval feature flag is a key on `TuvalFeatures`, read at boot out of the `features` block of
the config layers and reaching the page only through the generated `virtual:tuval/features`
module.**

Adding a flag is three edits and no new machinery: the key with its doc comment on
`TuvalFeatures`, its default in `featuresOff`, and the matching optional key on `DeclaredFeatures`
in `config.ts`. The generated module walks the resolved record rather than naming any flag, so
nothing in the page or the dev server changes. Default-off holds, exactly as
`product-development-cycle.md` requires of a user-facing change; flipping one on means editing
`.tuval/tuval.config.ts` and restarting the desk.

**Banned.**

- A flag service of any kind — Flagship, a local daemon, an HTTP read, a client SDK.
- A runtime toggle: nothing flips a flag in a running desk, and no command, spell or key binding
  does it.
- Per-user or per-viewer flag state. One desk resolves one record for its one operator.
- A flag read from the URL or from browser storage. The generated module is the only path to the
  page.

**Binding constraint.** A new flag is one key on `TuvalFeatures` with a default in `featuresOff`,
reachable on the page only through the generated module.

## Consequences

Tuval keeps the repo's default-off dark-ship rule while owning none of Flagship's machinery, and a
flag stays cheap enough that no author reaches past it. ADR 0081 is untouched: it decides the
substrate for the deployed `apps/web` Worker and this record decides Tuval's, so the two answer
different apps rather than one question twice. ADR 0083's split holds too — the flip is still a
human act by the person who owns the release, on a desk that has no other kind of person.

The cost is that a flip is not live. Editing the file and restarting is the whole flip procedure,
and a bad default reaches the operator as a restart rather than a dashboard click. That is the
trade the ruling accepts. It also means a Tuval flag is invisible to anything reading the repo's
flag inventory through Flagship — retirement is by hand, deleting the key once the feature is
settled.

## Records

no vocabulary impact
