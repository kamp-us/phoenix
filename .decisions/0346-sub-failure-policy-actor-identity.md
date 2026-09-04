---
id: 0346
title: A Sub fiber's failure is the machine's Msg or the process's death, never a host retry
status: accepted
date: 2026-09-03
tags: [tuval, demlik, effect-host, supervision, identity]
---

# 0346 — A Sub fiber's failure is the machine's Msg or the process's death, never a host retry

**What this decides:** when a long-running Sub fails inside the Effect host, the failure becomes a plain-data Msg the machine's reducer handles, and a machine that declares no handler loses the whole process; and every actor carries two identities, a declared definition name that Demlik mints a service key from and a process id the kernel mints per instance, with Demlik's `Identity<S, M>` staying the message filter it already is.

## Context

Epic [#7496](https://github.com/kamp-us/phoenix/issues/7496)'s first amendment made the Tuval kernel Effect-native and said two things were designed nowhere: what happens when a Sub fiber fails, and what a nominal per-definition actor identity is. It ruled that the kernel designs both and pushes the result back to [kamp-us/demlik#36](https://github.com/kamp-us/demlik/issues/36), the `tea-effect` host, rather than waiting on it. Child [#7518](https://github.com/kamp-us/phoenix/issues/7518) is that slice: this record, plus a report filed on `kamp-us/demlik`.

The in-tree host as built ([#7510](https://github.com/kamp-us/phoenix/issues/7510), `apps/tuval/src/host/actor.ts`) forks each manual Sub handler into its own child Scope with `Effect.forkIn` and wraps it in `Effect.catchCause(reportCause("sub-fiber"))`. A Sub that fails is logged under a host-only phase and its fiber ends, but its id stays in the host's running map, so the Sub is dead and still registered until the state stops desiring it. Nothing tells the reducer. That is the silent failure Demlik's invariant 6 forbids, and it is the gap this record closes.

### What the ground says

Demlik at `kamp-us/demlik` main `2ed72ceb` (version `0.12.0`, the pin `apps/tuval` links):

- `src/runtime-types.ts`, `RuntimeErrorPhase`: the runtime knows eleven phases and none of them is a Sub running. A Sub in 0.12 is opened synchronously and hands back a `Dispose`; after opening, its only channel back into the machine is `dispatch`. The only failure phases a Sub has are `"sub-cleanup"` (a `Dispose` threw or rejected, `src/run.ts` `stopSubs` and `disposeDepSubs`) and a throw at open, which `reconcileSubs` / `reconcileDepSubs` remember and re-throw after the pass so siblings still arm.
- `src/runtime-types.ts`, `Supervision`: `stop` / `escalate` / `restart` govern a reducer throw and nothing else. `restart` needs a host-supplied `rehydrate`, synchronous, because the reducer is.
- `src/with-resilience/index.ts`, header rules 1 to 5: retry, backoff, breaker and deadline are machine data (`model.$resilience`), every decision is a Msg or Cmd through `update`, timers are Subs merged by id, and an error crossing into state is a `{_tag, ...}` sentinel, never a `new Error`.
- `src/pure/core.ts`, the `Identity<S, M>` block: identity is two pure projections, `ofState` and `ofMsg`, compared by `structuralHash` per transition; a mis-addressed Msg is dropped before `update`. It is derived from state and exists to filter messages. It is not a name.
- `src/subs/managed-resource.ts`, `subscribeHandler`: an acquire that throws propagates out of reconcile and registers nothing; an async release rejection reaches `onError` under `"sub-cleanup"`.

Effect at the `4.0.0-rc.112` pin (`Effect-TS/effect`, tag `effect@4.0.0-rc.112`):

- `LLMS.md`, "Managing resources and `Scope`s": a resource's lifetime is a Scope, acquired with `Effect.acquireRelease`, released when the Scope closes. `packages/effect/src/Scope.ts`, `fork`: closing the parent closes the child with the same exit.
- `packages/effect/src/Effect.ts`, `forkIn`: "The fiber will be interrupted when the scope is closed." That is the whole contract. A forked fiber's failure reaches nobody unless something joins it; `packages/effect/src/FiberSet.ts`, `join`, is the one primitive that fails the parent with a member's first failure.
- `LLMS.md`, "Working with Schedules": `Effect.retry` with a `Schedule` is the host-local retry. Grilling ruling #7371 (recorded on the epic) allows it for one ephemeral I/O attempt only; durable or user-visible retry policy stays in Demlik state, and one operation has exactly one declared resilience owner.
- `packages/effect/src/Context.ts`, `Service`, under Gotchas: "The string key is the runtime identity of the service. Reusing the same key string for unrelated services makes them occupy the same slot in a `Context`."

## Decision

**A Sub fiber that fails ends as a Msg the machine declared for it; a machine that declared none loses the process; the host never retries a Sub on its own.**

The machine declares one pure projection beside `identity`:

```ts
subFailure?: (sub: U, failure: SubFailure) => M | undefined;
```

`SubFailure` is plain data: the Sub's `id` and `type`, a `reason` of `"failure"` (the handler's error channel) or `"defect"` (a throw or a die), and the squashed `message`. No `Cause`, no `Error` instance, no Effect value crosses into the machine; the full `Cause` goes to `onError` under the `"sub-fiber"` phase first, before anything else happens, so the failure is visible as data whichever branch follows.

The host's mechanics, in order, when a Sub fiber exits with a failure before its Scope was closed:

1. Report the `Cause` to `onError` under `"sub-fiber"`.
2. Mark the Sub's id `failed` in the running map. Reconcile never re-arms a `failed` id while the state keeps desiring it; the same id means the same lifetime, and that lifetime ended. A restart is the reducer emitting the Sub under a new id (an attempt counter in the id or in the dep-keyed `deps` slice), which reconcile arms as a fresh Sub. The retry count and backoff timers that decide whether to do so are machine state, the `withResilience` shape, replay-visible.
3. When `subFailure` is declared and returns a Msg, dispatch it through the ordinary follow-up path (the same unawaited dispatch a Sub's own `dispatch` uses), so it obeys the stop gate and the serial tail and lands after the transition in flight.
4. When `subFailure` is undeclared, or returns `undefined`, the failure is unaddressed, and the host closes the process's Scope with the failure as its Exit. The process leaves the table; its Subs, disposers and finalizers run as the one shutdown protocol the process slice already has. The parent is not killed, because `Scope.fork` closes children with the parent and not the other way round.
5. When `subFailure` itself throws, that is user code failing while handling a failure. Report it under `"sub-fiber"` as `UserCodeThrew` and take branch 4. The policy failing is not retried and not swallowed.
6. When the Msg from branch 3 makes the reducer throw, the machine's `supervision` governs it under `"reduce"`, exactly as any other Msg.

A Sub fiber that completes normally is not a failure. Its id is marked `ended`, it is not re-armed under that id, and no Msg is sent; a handler with something to say dispatches it before returning.

The three candidates, and why this one:

- **Kill the process** on every Sub failure makes the host the resilience owner of every Sub, with a policy no machine can see or override. Kept only as the fallback for the unaddressed case, where the alternative is a silently dead Sub.
- **Restart under a declared policy** in the host (`Effect.retry` with a `Schedule` on the Sub fiber) is exactly the opaque host-local retry ruling #7371 bans for anything durable or user-visible: the policy would live in the definition, not in state, so replay could not see why a Sub came back and a snapshot could not carry the attempt count. It also makes two owners of one operation when the machine also tracks attempts.
- **Surface a typed Msg** keeps the machine the one owner. The Sub's lifetime was already the reducer's to declare, through the desired set; its ending is the same reducer's to decide about. Restart is data, so it replays.

**Every actor carries a declared definition name and a minted instance id; the name is Demlik's, the id is the host's, and neither lives in state.**

- **Definition name.** `defineActor` takes a required `name: string`. Demlik's `tea-effect` mints the actor's service key from it, `Context.Service<...>(\`demlik/actor/${name}\`)`, so two definitions with identical `S`, `M` and `E` get distinct keys, the nominal identity `Context.ts` says the string key is. Reusing a name is the collision the same gotcha describes, and `defineActor` refuses a name it has already seen in the process, the way Demlik's `definePort` refuses a repeated port name. This belongs in Demlik: it is a property of a definition, and the host-neutral core is where definitions are made. In Tuval the name is the registry row's `ProgramId`.
- **Instance id.** The host mints one opaque id per running instance and never derives it from state. In Tuval that is the `ProcessId` the process slice already mints at spawn (`apps/tuval/src/process/Processes.ts`, `randomUUID`). This belongs in the host, because Demlik has no notion of an instance: `run` hosts one machine, and "one instance per run" was always the host's promise (`core.ts` cites the Durable Object's `idFromName(runId)`). `tea-effect`'s `make` accepts the id as an option and exposes it on the `ActorHandle` beside the name; a host that passes none gets one minted for it.
- **The pair is the address.** `(name, instanceId)` distinguishes two instances of one program from an instance of another, survives any change to the state's shape, and is what durability keys a snapshot on and what the process table reports. The service key answers a different question, "which one actor of this definition does this Context hold", so `layer(key, definition)` stays the singleton-per-definition form and instances live in the process table, never in a Context slot each.
- **Demlik's `Identity<S, M>` is unchanged.** It answers "is this Msg for the state I hold" and stays structural, derived from state, compared per transition. It is not a name and is not asked to become one.

**Binding constraints.**

- No host, in-tree or Demlik's, retries a Sub fiber. `Effect.retry` may wrap one I/O attempt inside a handler; it never wraps the Sub's lifetime.
- No `Cause`, `Error` instance, Fiber or Scope reaches a reducer through `SubFailure`.
- A `failed` or `ended` Sub id is never re-armed under that id; restart is a new id declared by the reducer.
- An unaddressed Sub failure closes the process Scope with the failure as its Exit. It is never logged and left.
- A definition name is declared, unique per process, and never derived from state; an instance id is minted by the host and never derived from state.

## What spike #7470 did not prove

This record designs on top of what #7470 established and no further. That spike (verdict recorded on epic #7496 and on kamp-us/demlik#36) proved a host-neutral core plus a `tea-effect` host on the flat reducer form, with parity against Demlik's `run` on states, snapshots, one Sub start and stop, and a loud dispatch-after-stop. It did **not** prove: transitions tables, ports, supervision, dep-keyed Subs, identity filtering, events, detached handlers, disposal timeouts, the full Demlik suite, any Sub-fiber failure policy, nominal actor identity, concurrency fairness or teardown races, or Effect 4's final API. The two designs above are grounded in source and are untested: the in-tree host today logs and leaves a failed Sub, and mints no definition name. A later reader should read this as the design the host is to be brought to, not as behaviour it has.

## Consequences

- The in-tree host (`apps/tuval/src/host/`) changes to match: `subFailure` on `CoreMachine`, the `failed` / `ended` marks in the running maps, the process-Scope close on an unaddressed failure, and `name` on `defineActor`. This slice writes none of it (#7518 changes nothing under `apps/tuval/src/`); a follow-up issue carries it.
- The durability slice keys snapshots on `(ProgramId, ProcessId)`. A process that died on an unaddressed Sub failure restores at boot from its last save and re-arms the same Sub; if that fails again the boot fails loudly, once. The host does not loop.
- The same design goes to `kamp-us/demlik` as a plain report on #36's lane for their triage, per the #7468 ruling. When `tea-effect` ships with it, `apps/tuval/src/host/demlik-bridges.ts` is deleted and the in-tree implementation of both goes with it.
- Program authors gain one obligation: a program whose Subs can fail declares `subFailure`, or accepts that a failure ends the process. The Pi session and shell programs, whose Subs are streams that can drop, will declare it.

## Records

no vocabulary impact
