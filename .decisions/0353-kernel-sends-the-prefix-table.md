---
id: 0353
title: A Tuval page routes keys over the prefix table the kernel sent it, never one of its own
status: accepted
date: 2026-09-05
tags: [tuval, shell, transport, keys]
---

# 0353 — A Tuval page routes keys over the prefix table the kernel sent it, never one of its own

**What this decides:** the Tuval shell core answers a key with Cmds, three of which only a browser page can run; those stay the page's to derive, and the kernel hands the page the one key grammar it may derive them from.

## Context

The shell core (`apps/tuval/src/shell/core/machine.ts`) answers each Msg with state plus a list of Cmds. Three of its eight arms are things no kernel handler can answer, and `apps/tuval/src/shell/host/effects.ts` leaves exactly those three inert: `openCommandLine`, because the line is a page element, and `startRepeatTimer`/`cancelRepeatTimer`, because a handler returns its follow-up Msgs and holds no dispatcher it could fire a timer through. The wire (`apps/tuval/src/shell/transport/wire.ts`) carries no Cmd frame — a page learns state and never instructions — so the browser surface works them out again by running the shell's own pure `route` a second time over the prefix snapshot the kernel sent (`apps/tuval/src/shell/ui/frame.ts`).

`forwardKey` is the arm that looks page-run and is not. A key with the prefix unarmed belongs to the focused window's *process*, and the kernel delivers it as that program's own `key` Msg. The page separately hands the same key to that window's React renderer off its own `surfaceKey` answer, so one keystroke has two deliveries by design — but only one of them runs the Cmd.

That was correct and unheld. Both sides called one pure function over one `PrefixTable`, which is an argument rather than a guard, and the page's table was a React prop defaulting to `defaultPrefixTable` while the kernel's was whatever `shellProgram({table})` was built with. `applyKeysConfig` already exists, so a config-supplied table is a shape the code can produce today; the two sides agreed only because nobody had passed one yet. A page handed a different grammar than the shell process was built with would simply stop opening its own command line, silently.

The wire in question is the shell transport's — the socket that carries the process table and each process's state. It is not the Tuval protocol of [ADR 0348](0348-tuval-command-framework-spell-registry-versioned-protocol.md), whose four Schema messages carry spell calls and their replies; that protocol is untouched here, and "a spell call is the only page-to-kernel message" still holds, because a prefix table travels kernel-to-page.

[#7781](https://github.com/kamp-us/phoenix/issues/7781) put two directions to the founder. Direction 1 added a fifth server frame carrying the Cmds a socket's page is meant to run. Direction 2 recorded the split as deliberate and named the page-run arms in the type. The founder ruled Direction 2 on 2026-09-04, with two additions: the kernel sends the prefix table on attach and that table is the only one the page may route over, and one unit test walks every table entry asserting the two sides agree.

## Decision

**The page-run Cmd arms stay the page's to derive, and the only grammar it may derive them from is the prefix table the kernel sent it on attach.**

- `ShellCmd` is the union of two named halves. `PageCmd` holds `openCommandLine`, `startRepeatTimer` and `cancelRepeatTimer` — the arms a browser surface answers. `KernelCmd` holds `forwardKey`, `runCommand`, `openProgram`, `attachProcess` and `reloadConfig` — the arms the kernel's `HostHandlers` answer. `ShellCmd` is defined as `KernelCmd | PageCmd`, so a ninth arm cannot be added without landing on a side.
- The division is who *runs* the arm, not who reacts to the key. `runCommand` and `reloadConfig` are `KernelCmd`s with no runner today — resolving a name the command table does not hold needs the spell registry, and `Booted.reload` sits above a handler's reach (#7743). Those are gaps in the host, not unclassified arms.
- The kernel sends its prefix table to the page as a `keys` server frame, written as the socket opens beside the registry catalog. `Duration` does not survive JSON, so the frame carries `repeatTimeoutMs` and the two ends convert.
- `DeskProps.table` is required. A page that has not been told its grammar renders no desk; it waits, exactly as it waits for its first shell snapshot.
- The duplicate routing is deliberate and is held by a test rather than by an argument: `apps/tuval/src/shell/ui/key-agreement.unit.test.ts` walks every entry of the table and asserts, per entry, that the core's Cmds and the surface's `surfaceKey` answer route the key the same way.

**Why not a Cmd frame.** A per-socket command channel does not exist: a dispatch returns nothing to the transport, and two pages attached to one shell would both be told to forward the same key. It also adds a kernel-to-page hop on every keystroke. The founder's remark that the kernel could own the prefix timer itself — a handler that sleeps and returns the timeout message — is an argument against Direction 1's premise, not work this ADR orders.

**Binding constraints.**

- No surface under `apps/tuval/src/` may route keys over a table it was not handed. `defaultPrefixTable` is the kernel's default and is named on the kernel path alone.
- A new `ShellCmd` arm is added to `KernelCmd` or to `PageCmd`, never to `ShellCmd` directly.
- The key-agreement walk covers every entry of the table it is given. A binding added to `defaultPrefixTable` is covered by construction; a test that samples entries instead of walking them does not discharge this.

## Consequences

- The two routings can no longer be handed different grammars, which is the failure the argument could not exclude.
- The transport gains a fifth server frame and `serve` gains a required `table`. Its one caller chain — `serveDesk`, then `bin.ts` — passes it explicitly.
- The kernel's table still has two namers on the boot path: `shellProgram`'s own default, taken when the config module registers the shell row, and the value `bin.ts` hands the transport. Threading one config-named table to both is [#7890](https://github.com/kamp-us/phoenix/issues/7890) and is not assumed here.

## Records

no vocabulary impact
