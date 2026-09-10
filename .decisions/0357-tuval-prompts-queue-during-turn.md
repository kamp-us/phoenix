---
id: 0357
title: A prompt written during a turn queues in the session, never refused and never a transcript row
status: accepted
date: 2026-09-06
tags: [tuval, ai-agent, ux]
---

# 0357 — A prompt written during a turn queues in the session, never refused and never a transcript row

**What this decides:** When you type into the Tuval chat composer while the agent is still working, the message waits in the session's own queue — visible, unsent — and goes out when that turn ends, instead of being refused as data.

## Context

The `ai-agent-session` core refused every `prompt` outside `ready`, `prompting` included. The composer it drives (`AgentChatInput`, `@kampus/design`) does the opposite: a submit while working is coerced to `follow_up`, sent through the bridge anyway, and optimistically logged as "The next prompt was queued." (`admin.agent.activity.followUpQueued`). Tuval's bridge dropped the delivery mode, the core refused the prompt, and the operator was told "queued" by one surface and "This message was not sent." by another, for the same keystroke — with their words in no transcript and no queue (#8159).

Two candidate homes for the queue were rejected. The composer already believes it queues, and a queue kept there would be one window's optimism: the other window over the same process would never see it, and a checkpoint would not carry it. The transcript is the other, and it is worse — a tail row for a message no backend has heard of claims a turn that does not exist, and the echo join (`core/fold.ts`) would then be reconciling against a turn nobody sent.

The session state is the home for the same reason it holds `sends` and `permissions`: Tuval's core owns state and a window renders it (ADR [0345](0345-tuval-lives-under-apps.md) puts that core in `apps/tuval`), and every field on it is plain data that a checkpoint round-trips.

## Decision

**A prompt the operator writes while the session is `prompting` is queued in `AiAgentSessionState.queued`; the running turn's own end is the only thing that admits one, and anything that breaks that continuity releases the whole queue back to the operator as an unsent send.**

The queue is `ReadonlyArray<QueuedPrompt>` (`key`, `text`, `timestamp`) — the same three facts an admission needs, so a flush is the ordinary admission path and not a second one. It is a checkpoint field like any other.

Admission is one function (`admit` in `core/machine.ts`), reached from two places: the `prompt` cell on a `ready` session, and the queue settle that runs after every cell which can land the session somewhere the queue's answer changes (`started`, `sent`, `event`, `failed`). Landing on `ready` admits the head; landing on `gone` or `idle` releases everything.

A released prompt becomes a `refused` `SendOutcome` under its own key, never `uncertain`: the text was never handed to a layer, so "it might have run" is not among the things nobody knows about it. The window is already holding each key's copy (`shell/chat/outgoing.ts`), so a release surfaces as the existing Restore / Discard bar rather than as silence. Three events release: an `interrupt` (stopping a turn is not asking the next one to start), a session that goes `gone` or `idle` under the queue, and a `restore` — the turn a queue was waiting for ended with the process.

**Binding constraints.**

- A queued prompt is **not** a transcript item. `promptItem` runs at admission, never at enqueue.
- Nothing but a turn's end flushes the queue. No timer, no reconnect shortcut, and no window-side resend.
- The queue is bounded (`queueLimit`). At the bound the **newest** prompt is refused against its own key; the oldest is never evicted, because silently dropping what an operator already wrote is the defect this record answers.
- A release is `refused`, never `uncertain`, and never an automatic resend.
- A window renders `state.queued` and holds no queue of its own.

## Consequences

Sending a follow-up mid-turn becomes the ordinary act the composer already advertises, and the two surfaces stop disagreeing. Both windows over one process show the same waiting text, and it survives a restart as a recoverable unsent message rather than vanishing.

The cost is that `prompting` is no longer a refusing phase, which changed four pinned cases in `core/machine.unit.test.ts` and the item-accounting predicate in `core/properties.unit.test.ts` (a prompt's item is now counted off the `aiAgent.prompt` Cmd, which is emitted at admission whether the prompt came from the cell or the queue). Every future cell that can land the session on `ready` must route its result through the queue settle, or a queued prompt sits there while the agent looks idle.

Steer and follow-up are still one thing to Tuval. The generic `TuvalAiAgent` interface has no steer — injecting into a running turn is a capability no port declares — so both delivery modes queue, which is at least what the copy now truthfully says.

## Records

no vocabulary impact
