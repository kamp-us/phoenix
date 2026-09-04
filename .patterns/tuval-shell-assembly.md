# Assembling the Tuval shell: kernel, socket, page

**Reference.** How `apps/tuval` goes from a config module to a desk a founder drives by keyboard —
what runs each of the shell core's Cmds, how a program row's services reach its handlers, who serves
the page, and how the three end-to-end proofs are written. Read it before touching
`apps/tuval/src/shell/host/`, `apps/tuval/src/page/`, `apps/tuval/src/bin.ts`, or the launch/spawn
seam in `apps/tuval/src/launch/`.

The parts below it are their own docs: the command framework is
[tuval-spells.md](./tuval-spells.md), the layout binding is
[layout-tree-with-resizable-panels.md](./layout-tree-with-resizable-panels.md).

## The four pieces, and who owns what

```
.tuval/tuval.config.ts     the shell row + the demo rows + the graph        (user-owned)
  └─ boot / start          registry → wiring → kernel → launch → restore    (src/boot.ts)
       ├─ shell process    the desk's state; its Cmds run in src/shell/host/effects.ts
       ├─ serveDesk        one WebSocket per page                           (src/shell/host/serve.ts)
       └─ servePage        Vite, in this same process                       (src/page/dev-server.ts)
            └─ the page    attach → render <Desk> → send Msgs back          (src/page/)
```

One rule holds the whole picture together: **the desk is the shell process's state, and the page is
a view of it.** Nothing on the page is authoritative, which is why two tabs show one desk and why a
dropped socket is repaired by attaching again rather than by replaying anything.

## A program row's `R` is satisfied at launch, not by the row

`shellProgram({effects})` needs `Registry`, `Processes` and `ProcessTable` to run `openProgram` and
`attachProcess` — the picker spawns. A row is pure data built before the kernel exists, so it cannot
close over them; it declares them as its `R` instead, and `launch` provides them:

```ts
// src/boot.ts
const launched = yield* launch(compiled, wiring, {services: kernel}).pipe(
  Effect.provideContext(kernel),
);
```

`launch` merges that context into each spawn's `SpawnOptions.services` beside the node's own
`ProcessPorts`. This is the only seam a program row's requirements can arrive through, and it is a
wiring decision rather than a capability grant — local program code is fully trusted, there is no
sandbox (#7484 R1.1).

**A restored process gets no such context.** `restore` spawns checkpointed processes the graph did
not plan (everything the picker opened), with no services. So a program that a *picker* may open must
have handlers that need nothing — `src/demo/log.ts` qualifies, `src/demo/counter.ts` does not, since
its `announce` handler wants `ProcessPorts`.

## Which Cmds the kernel runs, and which the surface does

The shell core emits eight Cmds. `src/shell/host/effects.ts` runs three of them and states why the
rest are inert:

| Cmd | Who runs it |
|---|---|
| `openProgram`, `attachProcess` | the kernel — `runPickerIntent`, whose answer is the follow-up Msgs |
| `forwardKey` | the kernel — `Processes.handle(id)` then `dispatch({type: "key", key})` |
| `runCommand` | nobody: the name is a user binding the command table does not hold; logged at debug |
| `startPrefixTimer`, `cancelPrefixTimer` | **the surface** — see below |
| `openCommandLine` | the surface — the line is a page element, not a process |
| `reloadConfig` | nobody yet: `Booted.reload` sits above the kernel, out of a handler's reach (#7743) |

**The prefix countdown is the surface's, and that is structural.** A kernel handler returns its
follow-up Msgs and has no way to dispatch one a second later, so it cannot run a timer. The snapshot
carries the armed window's length, so the page runs the countdown off state alone (`Desk.tsx`). Two
consequences a caller must hold:

- Anything driving the kernel with no page attached — a test, a script — has to fire
  `{type: "prefix.timeout"}` itself. A repeatable binding (`<c-h>`, `<c-l>`) deliberately leaves the
  prefix armed, and with no countdown it stays armed forever, swallowing the next key.
- The countdown's effect must depend on the prefix's **value**, never on the snapshot object. Every
  snapshot arrives freshly decoded, so an effect keyed on `state.prefix` re-arms on unrelated kernel
  traffic and never fires — a demo counter ticking once a second starved it indefinitely (#7782).
  The dispatcher is read through the `latest` ref for the same reason.

## `forwardKey` delivers a program's own `key` Msg

With the prefix unarmed every key belongs to the focused window, and the core answers with a
`forwardKey` Cmd naming the window's process. The host dispatches `{type: "key", key}` into it. A
program that wants the keyboard declares a `key` cell; one that does not simply drops the key at
debug, because a keystroke is not worth ending a desk over and the shell's error channel is `never`.

## What the page can and cannot see

The page reads two things off the wire: the shell process's state, and the process table. There is
**no registry frame**, and that shapes two decisions:

- The page's renderer table (`src/page/renderers.tsx`) is keyed by **program id**, not by the
  `RendererRef` a row declares — the table wire carries no renderer field. A row's `renderer` still
  decides whether the picker offers it at all (`showsInAWindow`), which is why every windowed program
  declares one.
- The page's picker offers **running processes only**; its programs section is empty and says so,
  because a page cannot enumerate what it could spawn. Opening by name still works through
  `prefix : window:open <program>`, which needs no list.

`AttachedDesk` opens **one subscription per process**, so two windows over one process are one state
with two view slots — the Vim buffer model (#7484 R1.3), not two copies.

## `pnpm dev` is one process

`src/bin.ts` boots the kernel, calls `serveDesk` (ephemeral port, a launch token minted in memory),
then `servePage`, which starts Vite through its **Node API in this same process**. That is why the
token never touches disk: the middleware answering `/__tuval/launch` closes over the URL directly. A
second `vite` command would have to be handed the token through a file or an environment variable,
and a token on disk outlives the boot that minted it.

`vite` is a devDependency and is imported dynamically, so `node src/bin.ts --no-page` boots a kernel
with no bundler present. A page that will not start is reported and the kernel keeps running.

## The three proofs

`src/shell/proof/end-to-end.integration.test.ts` is the shape to copy for anything driving the whole
app. Two rules make it a proof rather than a rehearsal:

- **Read state off the transport.** Never off the shell process's handle, never off a DOM. The page's
  view of the desk is the thing under test.
- **Drive it with keys.** `keys.press` for everything the prefix table binds, and for the two Msgs a
  *surface* derives from a key, call the function the surface calls — `pickerKey` for a chosen row,
  `readCommandLine` for a typed line — rather than hand-writing the Msg.

Two mechanics worth copying. A dispatch is acknowledged when the Msg reaches the actor, and the state
frame is a *separate* write on the same socket, so assert by waiting for the next state that
satisfies a predicate (`deskWhere`) and not on the ack. And give that wait its own timeout that dies
naming the last desk it saw — a bare vitest timeout tells you nothing about which key was lost.
