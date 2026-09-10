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
   `CommandHandlers<EffectFailure, CommandEffectServices>` where
   `CommandEffectServices = ProcessSelf | SpawnedProcesses | Processes`. `emitHandler` is the only
   reader of `ProcessPorts`, and it is unreachable from a compiled spell, so no spell requires that
   service. `HANDLERS` and `EffectServices` keep all six for the `update` path.
4. **A spell that runs *inside* a process is a different call site and is untouched.** Such a spell
   gets `ProcessPorts` through its process's own context, not through `Kernel`. Nothing here widens
   `Kernel`.

## Consequences

- A program that wants to announce does it from an `update` cell. A command that should cause an
  announcement `send`s into the program's own in-port and lets the cell emit — which is the same
  route any other caller takes.
- `apps/tuval/src/authoring/commands.unit.test.ts` no longer hand-provides a `ProcessPorts`: its
  effect test drives a `send` through a capturing `SpawnedProcesses`, and a `@ts-expect-error` case
  holds the refusal in place, so deleting the narrowing turns that test red.
- The erasure `executor.ts` describes is still erasure. This decision removes one service from what
  a compiled spell needs; it does not make the remaining ones compile-time. `CommandEffectServices`
  still names `ProcessSelf`, which `Kernel` does not carry either — the same shape one service over,
  filed as [#8858](https://github.com/kamp-us/phoenix/issues/8858).
