---
id: 0369
title: The agent composer has one chrome
status: accepted
date: 2026-09-09
tags: [design-system, frontend, agent-chat]
---

# 0369 — The agent composer has one chrome

**What this decides:** `AgentChatInput` renders the same chrome for every host. There is no
`variant` prop, no second documented shape, and no branch a part has to answer for twice.

## Context

The composer carried `variant: "harness" | "focused"`. It was not a size prop — #8669 made the
compact shape unconditional under both arms — it picked which chrome the composer wore. Six files
branched on it: the root class and the widget above the card (`Frame`), the connection status row
(`Surface`), the attach button and the overflow menu (`Toolbar`), flat-vs-disclosure activity
(`Inspector`), where project trust and effort live (`Pickers`), and the default send rule
(`deliveryRuleForVariant`). The stylesheet carried four `.kp-agent-chat--focused` blocks on top.

At `main` both shipping hosts passed `focused` — Tuval's chat window and its session transcript.
The `harness` arm's only homes were the atölye exhibit's knob and the design package's own tests;
apps/web has no harness surface. So the branch cost review attention on every change to the
composer and bought nothing a user could see
([#8712](https://github.com/kamp-us/phoenix/issues/8712)).

## Decision

The composer has one chrome, and it is the one both hosts already ran on.

- `variant` is gone from `AgentChatInput` and from `Root`'s published state.
- The connection status row and the widget-above-the-card are **deleted**, not rehomed. Tuval
  carries its own status bar; nothing else asked for them. `HarnessWidget` itself survives — the
  inspector's disclosure still paints it.
- The `.kp-agent-chat--focused` rules are now the unconditional ones.
- The atölye exhibits lose their variant knob; both keep the prompt and disabled knobs.
- `deliveryRule` stays an explicit prop, defaulting to `queue-while-working` — the rule the
  surviving chrome always implied, so no host's send behaviour moves.

## Consequences

Six files stop branching and the next control added to the composer has one shape to answer for.
A future apps/web agent surface that wants a status row owns that row itself, above the composer,
rather than asking the design system to carry a second chrome for it.

The i18n keys the deleted row read (`admin.agent.status.*`, `admin.agent.scope`) are still declared
in every catalog; retiring them crosses `apps/web`'s catalogs and Tuval's copy map and is tracked
separately.
