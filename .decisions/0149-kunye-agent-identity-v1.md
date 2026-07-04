---
id: 0149
title: künye agent-identity v1 — the barest agent-identity primitive (Discord app/bot model); a human registers a bot (`user.type:"bot"` + apiKey), owned by a human for accountability, behind a cheap owner-side karma gate (yazar + small tunable delta); the agent is zero-permission, zero-rep
status: accepted
date: 2026-07-04
tags: [kunye, agent, identity, bot, karma, authz]
---

# 0149 — künye agent-identity v1 — the barest agent-identity primitive

## Context

Issue [#145](https://github.com/kamp-us/phoenix/issues/145) (a child of the künye epic [#41](https://github.com/kamp-us/phoenix/issues/41)) asks how **agent identities** register as first-class identities. The scaffolding to ride already exists: the `user.type` enum is already `"human" | "bot"` (default `"human"`), the `apiKey` table is migrated and matches better-auth's apiKey-plugin schema, and ADR [0045](0045-kampus-client-cli.md) explicitly deferred "how an agent obtains its own identity (not borrowing a human's)" to this künye epic.

The model is the **Discord app/bot** shape: a human registers a bot, the bot is a first-class identity with its own credential, and the bot acts as *itself* — never by borrowing a human's session. That last point is the **phoenix[bot] accountability lesson** (ADRs [0143](0143-reject-phoenix-bot-authorship.md), superseding [0140](0140-phoenix-bot-authors-pipeline-prs-team-cp.md) / [0142](0142-bot-credential-resolution-convention.md)): the whole phoenix[bot] pipeline-authorship direction was rejected because an agent that could *act as a human* collapsed a two-human gate to zero humans. The durable lesson: **agents act as themselves, and a human is always the responsible owner** — accountability and attribution flow to a real person, never to an anonymous automated actor.

This child designs and records the **künye-side identity model only**. It does not enable the apiKey plugin (ADR [0044](0044-imge-media-architecture.md) Decision 3 owns that) and does not implement the registration mutation.

## Decision

**v1 scope: "you can have agents, that's it."** The barest agent-identity primitive — nothing more.

- **A human registers a bot.** A registered agent is a `user` row with `type: "bot"` plus its own **`apiKey`** credential (a durable, revocable better-auth credential). This *rides* better-auth rather than sitting beside it: the `user.type` enum and the `apiKey` table already exist, so agents are already representable in the identity table — a second identity store would be pure duplication.
- **The bot is owned by a human.** The registration record carries an **owner FK** (bot → owning-human) for **accountability + attribution** — the phoenix[bot] lesson made concrete: an agent acts as itself, and a responsible human owner is always resolvable behind it.
- **Karma-gated registration, cheap.** To register an agent, the **owner** must be a **yazar** (the base earned tier) **plus a modest additional karma bump** — "earned yazar; prove a little more to bring your agents." This is cheap anti-spam, not gatekeeping. It reuses künye's karma-gated-privilege machinery (the same `packages/authz` capability-as-Effect mechanism used by [#150](https://github.com/kamp-us/phoenix/issues/150)). The exact threshold is a **tunable constant**: this ADR names the *shape* (yazar + a small delta) and picks a **low starting value**.
- **The gate is on the owner's right to register.** The **agent itself is zero-permission, zero-rep** in v1 — it carries no karma privileges and no rep ledger. This is the fail-closed posture the authz framework already anticipates: ADR [0107](0107-capability-authz-framework.md) §6's `AgentAuthority` port is filled by `AgentAuthorityV1`, which admits an agent **nothing**; v1.1 swaps that one Layer for the real policy with no edit to `packages/authz`. The registration record holds **just identity + credential + owner** — nothing else.

## Consequences

**Deliberately deferred to v2+ (solid-base-first — recorded *with* the why):** agent permissions, an agent rep ledger, richer registration policy, and the whole "humans + agents together" collaboration vision. v1 is **only** the identity primitive. The reason is deliberate: ship the barest correct identity substrate first, prove it, then layer authority and reputation on a base that is already solid — rather than co-designing the permission/rep model against an identity primitive that hasn't shipped. The zero-permission, zero-rep agent is not an omission; it is the whole v1 posture, and `AgentAuthorityV1`'s fail-closed nothing is its enforcement point.

**Out of scope (unchanged):**

- **Enabling the apiKey plugin itself** — ADR [0044](0044-imge-media-architecture.md) Decision 3 owns that (the `@better-auth/api-key` dependency add + register). This ADR designs the künye-side identity model *on top of* that credential, not the credential machinery.
- **Implementing the registration mutation** — this child designs and records the identity model only; the mutation that mints a `type:"bot"` user + apiKey behind the owner-side gate is separate work.

## Links

- [#145](https://github.com/kamp-us/phoenix/issues/145) — this child (design agent identity registration).
- [#41](https://github.com/kamp-us/phoenix/issues/41) — the künye epic (per-user reputation DO: karma, invites, agent identity).
- [#150](https://github.com/kamp-us/phoenix/issues/150) — the karma-gated privilege checks whose machinery the owner-side registration gate reuses.
- ADR [0044](0044-imge-media-architecture.md) (issue [#44](https://github.com/kamp-us/phoenix/issues/44)) — owns apiKey-plugin enablement (Decision 3); explicitly out of scope here.
- ADR [0045](0045-kampus-client-cli.md) — deferred "how an agent obtains its own identity" to this epic.
- ADR [0107](0107-capability-authz-framework.md) — the `AgentAuthority` port + fail-closed `AgentAuthorityV1` seam that pins the agent's v1 zero-permission posture.
- ADRs [0143](0143-reject-phoenix-bot-authorship.md) / [0140](0140-phoenix-bot-authors-pipeline-prs-team-cp.md) / [0142](0142-bot-credential-resolution-convention.md) — the phoenix[bot] accountability lesson (agents act as themselves; a human is always the responsible owner).
