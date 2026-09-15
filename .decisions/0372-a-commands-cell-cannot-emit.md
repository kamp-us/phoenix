---
id: 0372
title: A program's commands cell cannot declare emit, because a spell call runs under no process
status: accepted
date: 2026-09-09
tags: [tuval, authoring, commands, spells, effects, ports]
---

# 0372 — A program's `commands` cell cannot declare `emit`, because a spell call runs under no process

**What this decides:** the effects a declared command may ask for are `spawn`, `send`, `ask`,
`reply` and `stop` — every effect an `update` cell may ask for, less `emit`. `emit` stays an
`update` cell's alone. An `emit` written in a `commands` cell is a type error where it is written,
not a missing-service defect at the first call.

**Amended 2026-09-14 (see Consequences):** the rulings on
[#8898](https://github.com/kamp-us/phoenix/issues/8898) and
[#8858](https://github.com/kamp-us/phoenix/issues/8858) ran this record's own argument the rest of
the way. A declared command may ask for `send` and nothing else, and a bare port name in one means
an in-port of the declaring program's own process. The paragraph above is what was decided on
2026-09-09 and is kept as written; the list of four other effects is no longer the live rule.

Founder ruling: <https://github.com/kamp-us/phoenix/issues/8766#issuecomment-5612412328> — "Ruled:
direction 2. A commands cell cannot declare emit; a spell call from a scope with no process has no
caller to emit from." Same shape as the ruling on #8757: what belongs to a process is stamped by the
kernel off the process it is interpreting for, never carried by the effect.

## Context

#8766 named the gap. `compileCommands` (`apps/tuval/src/authoring/commands.ts`) built each spell's
`execute` by driving the declared `run`'s effects through the spine's handlers, so a command
answering `emit(...)` required `ProcessPorts`. The `Kernel` union in `apps/tuval/src/boot.ts` does
not name that service. Nothing caught it: `AnySpell` erases a spell's requirements, which is exactly
the erasure `apps/tuval/src/commands/executor.ts`'s docblock says the composition root owes a
provider for. The unit test passed a hand-built `ProcessPorts` layer, so no test was red either.

Under it sat a design question the wiring could not answer. `ProcessPorts.emit(port, payload)`
announces on **a running process's** out-port. A spell call is not a process step: the `Scope` it
runs under (`apps/tuval/src/commands/spell.ts`) names a workspace and a client, and its `process`
is *the caller's* — the process the kernel resolved the call from, which is how `process spawn`
picks a parent (`apps/tuval/src/commands/core/process.ts`). It is never the declaring program's own
process. So adding `ProcessPorts` to `Kernel` would have satisfied the checker while leaving the
runtime question open in both directions: with no `process` in scope there is no out-port at all,
and with one there is an out-port belonging to somebody else.

## Decision

1. **`emit` is not declarable in a `commands` cell.** `CommandEffect` in
   [`apps/tuval/src/authoring/commands.ts`](../apps/tuval/src/authoring/commands.ts) is
   `Exclude<ProgramEffect, EmitEffect>`, and `CommandAnswer` is built over it — so the refusal lands
   on the author's `run` at the line that wrote it.
2. **What an `emit` from a `commands` cell means: nothing, in either scope case.** With no `process`
   in the calling `Scope` there is no out-port for the payload to leave by. With one, that process
   is the caller's and its out-ports are not the declaring program's to announce on. There is no
   reading under which the call is honest, which is why the answer is a refusal rather than a
   fallback.
3. **The narrowing is carried by the handler table, not by a runtime check.** `COMMAND_HANDLERS` in
   [`apps/tuval/src/authoring/define-program.ts`](../apps/tuval/src/authoring/define-program.ts) is
   the spine's five command-reachable handlers, typed
   `CommandHandlers<EffectFailure, CommandEffectServices>` where `CommandEffectServices` is
   `Exclude<EffectServices, ProcessPorts>`, so it stays in lockstep as the spine's service set
   grows. `emitHandler` is the only
   reader of `ProcessPorts`, and it is unreachable from a compiled spell, so no spell requires that
   service. `HANDLERS` and `EffectServices` keep all six for the `update` path.
4. **A spell that runs *inside* a process is a different call site and is untouched.** Such a spell
   gets `ProcessPorts` through its process's own context, not through `Kernel`. Nothing here widens
   `Kernel`.

## Consequences

> **Amended 2026-09-14 — a command may declare only `send`, and a bare port name means its own
> program.** The founder ruled #8898 and #8858 together on 2026-09-10 PT
> (<https://github.com/kamp-us/phoenix/issues/8898#issuecomment-5625301070>,
> <https://github.com/kamp-us/phoenix/issues/8858#issuecomment-5625302266>), and both rulings ran
> the argument in the Decision above one effect further. The two bullets this section used to carry
> as open holes are closed below; the decision itself is unchanged, and `emit` is still refused for
> exactly the reason stated.

- **`CommandEffect` is `SendEffect<SendTarget>`: `send`, and nothing else.** The same argument that
  refused `emit` refuses the other four, which is what the rulings say. `spawn` stamps a child's
  parent off `ProcessSelf` and `ask` routes its answer to the same service; a spell call runs under
  no process, so neither has an honest `self` — that was #8858's whole question, and `Kernel` in
  [`apps/tuval/src/boot.ts`](../apps/tuval/src/boot.ts) names `ProcessSelf` no more today than it
  did then, and must not be widened to. `reply` spends a correlation a request-port arrival carried,
  and a spell call was asked nothing. `stop` ends a process the call was handed no claim on. The
  refusal is the checker's at the line that wrote it, and
  [`apps/tuval/src/authoring/commands.unit.test.ts`](../apps/tuval/src/authoring/commands.unit.test.ts)
  holds one `@ts-expect-error` case per refused effect.
- **`COMMAND_HANDLERS` is one key.** It is `{send: sendHandler}`, typed over
  `CommandEffectServices = Extract<EffectServices, SpawnedProcesses>`. `ProcessPorts` and
  `ProcessSelf` — the two services `Kernel` does not name — are both unreachable from a compiled
  spell rather than merely unused by one, so the erasure `executor.ts` describes no longer hides
  anything the composition root owes. `HANDLERS`/`EffectServices` keep all six for the `update` path.
- **The recorded route is "send to your own program", and it is now offered.** A command that should
  cause an announcement `send`s into its own program's in-port and lets the `update` cell that owns
  it emit. The bare form — `send("pr", pr)` — names a port and no process;
  [`apps/tuval/src/authoring/own-process.ts`](../apps/tuval/src/authoring/own-process.ts) resolves it
  at the call, against the declaring program, by the ruled three-case rule: exactly one live process,
  that one; several with the caller's own `Scope.process` among them, the caller's; anything else, a
  typed refusal (`NoLiveProcess`, `AmbiguousProcess`) naming the program and the ambiguity, which
  comes back as a spell reply rather than a silent no-op. The explicit `send({process, port}, …)`
  form is untouched, for the process a command was handed as an argument.
- **`ProcessTable` is the read, and `Kernel` already names it.** The question is "which processes of
  this program are alive", which only the live table answers; `SpawnedProcesses` holds a subset. So
  the resolution widens what a compiled spell requires by one service the composition root was
  already providing, and by nothing else.
- **The worked example is the thing to copy again.**
  [`apps/tuval/src/authoring/example/pr-review.ts`](../apps/tuval/src/authoring/example/pr-review.ts)
  declares `run: (pr) => send("pr", pr)` — the shape epic #8716 R16.1 and ticket #8734's criterion 7
  always specified. Those two live only in closed GitHub issues, so there is nothing in-tree left
  prescribing the old `send({process, port: "pr"}, …)` route.
- **One reach remains narrower than the resolution.** `sendHandler` delivers through
  `SpawnedProcesses`, which holds only the processes it spawned, so a bare send that resolves to a
  *graph-launched* process of the declaring program is refused `UnknownProcess`. That is the
  pre-existing gap [#8944](https://github.com/kamp-us/phoenix/issues/8944), not a new one: the same
  is true of the `process send` spell today. Resolution is deliberately over the true live set
  anyway — answering "no live process" while one is plainly running would be the dishonest half.
- `apps/tuval/src/authoring/commands.unit.test.ts` no longer hand-provides a `ProcessPorts`: its
  effect test drives a `send` through a capturing `SpawnedProcesses`, and the `@ts-expect-error`
  cases hold the refusals in place, so deleting the narrowing turns that test red.
  `apps/tuval/src/authoring/own-process.unit.test.ts` drives the resolution on a real kernel, where
  the payload crosses the in-port's own queue and pump — the reach a stubbed service cannot show.
