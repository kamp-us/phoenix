---
id: 0408
title: A Tuval Sub maps its own failures into Msgs, and an unmapped Sub failure stops the process
status: accepted
date: 2026-09-25
tags: [tuval, demlik, effect-host, supervision]
---

# 0408 — A Tuval Sub maps its own failures into Msgs, and an unmapped Sub failure stops the process

**What this decides:** Tuval drops the `subFailure` hook from ADR 0346 and does what `@demlik/tea`
0.18 does. Each Sub runner catches the errors it expects and turns them into Msgs. Any other Sub
failure stops the run and closes its Scope. ADR 0346's rule on actor identity still stands.

## Context

[ADR 0346](0346-sub-failure-policy-actor-identity.md) ruled two things. First, a Sub fiber's failure
goes through a machine-declared `subFailure?: (sub, failure) => M | undefined` projection, and a
machine with no answer loses its process. Second, every actor has a declared definition name plus a
host-minted instance id. Tuval built the first half in its own host: `packages/tuval/src/sub-failure.ts`
and the running, failed and ended marks in `packages/tuval/src/host/actor.ts`.

The same design went to demlik as [kamp-us/demlik#309](https://github.com/kamp-us/demlik/issues/309).
The founders ruled against it there (R3.1 in grilling session
[kamp-us/demlik#325](https://github.com/kamp-us/demlik/issues/325)) and took the Elm shape instead.
Elm's `Sub msg` has no error type, so a Sub turns its own failures into Msgs. A failure it did not
handle stops the run with that failure as its exit. #309's criteria say so: no `subFailure` slot on
`Machine` or `run`. `@demlik/tea` 0.18.0 ships that behaviour.

Epic [#9785](https://github.com/kamp-us/phoenix/issues/9785) moves Tuval onto 0.18.0 and deletes
Tuval's own host. tea has nothing like the `subFailure` hook, so the hook has to be retired or kept
as Tuval-only code on top of tea. The founder ruled on the epic
([ruling, 2026-09-25](https://github.com/kamp-us/phoenix/issues/9785#issuecomment-5826340723)):
drop the hook, follow tea 0.18, let each Sub runner catch its own errors and turn them into Msgs,
and let an uncaught Sub failure stop the run. This record writes that ruling down.

## Decision

**A Tuval Sub turns the failures it expects into Msgs itself, and a Sub failure it does not map
stops the process and closes its Scope.**

- A Sub runner that can fail in an expected way catches that error inside its own stream and emits
  a plain-data Msg for it, for example
  `Stream.catchTag("SomeExpectedError", () => Stream.make({ type: "failed" }))`. The reducer handles
  that Msg like any other. The AI-agent events Sub already works this way: it catches its
  `TransportError` and dispatches `failed` (`packages/tuval/src/ai-agent/handlers/index.ts`).
- A Sub failure the runner did not map is not the machine's to handle. tea stops the run and closes
  its Scope with that failure as the exit. In Tuval that is the process leaving the table through
  its normal shutdown.
- Tuval adds no failure policy on top of tea. No `subFailure` slot on a machine, program or
  `defineActor`, no `SubFailure` type, and no host code that turns a Sub failure into a Msg.

**What this retires from ADR 0346.** The whole Sub-failure half: the `subFailure` projection, the
`SubFailure` data type, the host mechanics that report under a `"sub-fiber"` phase, mark the id
failed, dispatch the projected Msg and route a throwing projection through `UserCodeThrew`, the
never-re-arm rule for `failed` and `ended` ids, and the Binding constraints on `SubFailure` and
re-arming. Two of ADR 0346's rules still hold and are not reopened here: no host retries a Sub, and
a Sub failure nobody handled closes the process Scope, never logged and left. tea now enforces the
second one.

**What stays from ADR 0346.** The actor-identity half, unchanged: a declared definition name that
the service key is minted from, a host-minted instance id, the `(name, instanceId)` pair as the
address, and demlik's `Identity<S, M>` staying a message filter. Its binding constraint on names
and instance ids still binds.

**Binding constraints.**

- A Sub whose failure the machine must react to maps that failure into a Msg inside its own runner.
- Tuval never re-adds a `subFailure` hook, or any other host-level Sub-failure-to-Msg projection,
  over tea.
- An unmapped Sub failure ends the process. It is never logged and left running.

## Consequences

- Epic #9785 deletes `packages/tuval/src/sub-failure.ts`, its tests, and the `subFailure` field that
  `packages/tuval/src/registry/program.ts` adds to `Machine`. It does not port them onto tea.
- A program author who used to declare `subFailure` now handles those errors in the Sub runner. A
  program that does neither loses its process on the first failure, as it already did under ADR
  0346 when no handler was declared.
- The failure can no longer be seen at one central hook. Each Sub decides which errors are
  expected. Anything it misses stops the process loudly, not quietly.

## Records

no vocabulary impact
