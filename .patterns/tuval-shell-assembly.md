# Assembling the Tuval shell: kernel, socket, page

**Reference.** How `apps/tuval` goes from a config module to a desk a founder drives by keyboard —
what runs each of the shell core's Cmds, how a program row's services reach its handlers, who serves
the page, which of the app's two entries a module belongs to, and how the three end-to-end proofs
are written. Read it before touching `apps/tuval/src/shell/host/`, `apps/tuval/src/page/`,
`apps/tuval/src/bin.ts`, `apps/tuval/tsconfig.browser.json`, or the launch/spawn seam in
`apps/tuval/src/launch/`.

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

## A windowed program: the reference, the shared window, the extras slot

Three files, and the split between them is forced rather than stylistic.

- **The row names the window and reaches none of it.** A row is kernel-side data and must stay free
  of React, so the `RendererRef` it declares lives on a leaf that imports one type and nothing else
  — `src/pi/renderer-ref.ts` for `pi-session`. Retyping the name at both ends instead would drift
  silently: an unresolved reference is a returned value, never a throw
  (`src/shell/window/renderer.ts`), so the window comes up blank and nothing fails.
- **That leaf sits beside the row, not inside the renderer's directory.** The strict lens
  (`tsconfig.json`) is `composite` and must list every file it compiles, and a renderer directory is
  excluded from it whole because it imports `@kampus/design`, which needs the relaxed lens
  (`tsconfig.design.json`). A file the row imports out of an excluded directory is a `TS6307` on
  every build.
- **The leaf carries the program id too, and the page's renderer table keys on it.** The table is
  keyed by program id rather than by the `RendererRef.ref`, because the process-table wire carries a
  row's program and no renderer field (`src/page/renderers.tsx`). Importing that id from the row
  would pull `node:path` and Pi's model runtime into the page bundle, which is the black page of
  #7836 — so `PI_SESSION_PROGRAM` is declared on the leaf and `src/pi/program.ts` re-exports it.
- **The page's three React modules moved to the relaxed lens with it.** `main.tsx`,
  `AttachedDesk.tsx` and `renderers.tsx` reach `@kampus/design` through the table, so they are named
  in `tsconfig.json`'s `exclude` and in `tsconfig.design.json`'s `include`. `src/page/dev-server.ts`
  stays in the strict lens: it is Node-side and `src/bin.ts` imports it, so excluding `src/page`
  whole would `TS6307` the bin.
- **The renderer is a thin binding, and its extras go through one slot.** Both AI-agent programs
  render the one shared `ChatWindow` (founder ruling 2026-09-02, amended on #7572 / #7584):
  `chatWindow({extras})` takes a `(state) => ReactNode` that lands in the window's status bar beside
  the phase line and the mode switch, and that is the whole of what a program adds. Pi's is its
  usage line — model, cumulative cost, token counts, off `state.usage`
  (`src/pi/window/PiChatWindow.tsx`). It is a function of the live state because a renderer *is*
  `f(state, view)`; a renderer that accumulated its own totals would disagree with the checkpoint
  and with the other window over the same process. Wrapping the shared window in a program-specific
  container is the wrong shape for a second reason: `chat.css` re-declares the `@kampus/design`
  typography roles inside `.tuval-chat`, so a package primitive mounted *outside* that scope reads
  Tuval's two-part `--t-*` values as invalid shorthand and loses its whole `font` declaration.

## `pnpm dev` is one process

`src/bin.ts` boots the kernel, calls `serveDesk` (ephemeral port, a launch token minted in memory),
then `servePage`, which starts Vite through its **Node API in this same process**. That is why the
token never touches disk: the middleware answering `/__tuval/launch` closes over the URL directly. A
second `vite` command would have to be handed the token through a file or an environment variable,
and a token on disk outlives the boot that minted it.

`vite` is a devDependency and is imported dynamically, so `node src/bin.ts --no-page` boots a kernel
with no bundler present. A page that will not start is reported and the kernel keeps running.

**One process, but two ports — and the handshake's origin fence has to be told the second one.** The
socket and the page bind separately, so the `Origin` a browser puts on the WebSocket upgrade is the
*page* server's, never the socket's. A fence derived from the socket's port alone refuses the very
page it exists to admit, and every Node-client test still passes, because a Node WebSocket client
sends no `Origin` at all — the one input `checkHandshake` lets through unconditionally. That
combination shipped once and rendered a blank desk (#7560).

The rule that keeps it fixed: **the fence's origin set must include the page server's origin.**
`servePage` takes the `TransportServer` rather than its URL and calls `admitLoopbackPort` on it the
moment Vite binds, so serving a page and admitting its origin are one act and no caller can do the
first without the second. A change to either half owes the proof in
`src/shell/proof/end-to-end.integration.test.ts` that replays the upgrade **with** an `Origin`
header; nothing that attaches the ordinary way can fail when this breaks.

## Two entry points, two import surfaces

The app has exactly two entries and they run on different platforms: `src/bin.ts` under Node, and
`src/page/main.tsx` in the browser. **A module the browser entry reaches may not import `node:*`.**
Vite externalizes those specifiers, so the import survives the bundle and throws on first access —
the page is black before React mounts anything, and no test that drives the page's code under Node
can see it (#7836).

`apps/tuval/tsconfig.browser.json` is the whole guard, and there is deliberately no lint rule and no
bundler plugin beside it:

```jsonc
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": [],                      // no @types/node in scope
    "exactOptionalPropertyTypes": false
  },
  "include": ["src/page/main.tsx", "src/page/assets.d.ts"]
}
```

`exactOptionalPropertyTypes: false` rides along because the entry reaches `@kampus/design` through
the page's renderer table (#7573), and the package is source-consumed under that flag —
`tsconfig.design.json` carries the same relaxation for the same reason. This lens exists for
`types: []`; relaxing the other flag costs it nothing it was built to catch.

`types: []` is what does it: with no `@types/node`, `node:crypto` resolves to nothing, so any module
in this project's file set that imports one is a plain `tsc` error —

```
src/shell/ui/Desk.tsx(1,26): error TS2591: Cannot find name 'node:crypto'. Do you need to install
type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field
in your tsconfig.
```

The `include` is the entry alone. Everything else in the browser surface arrives by import, which is
what makes the project's file set *the entry's import graph* and nothing wider — a module no browser
entry reaches is not judged here, and that is correct. `apps/tuval`'s `typecheck` script runs this
project after the Node one, so both lenses are in the one gate.

**A barrel is the usual way a `node:` import gets in, so a shared slice keeps two.** `index.ts` is
the whole slice, for the kernel; `browser.ts` is the half a page may reach, and `index.ts` re-exports
it. Two slices carry the split today, and both were live routes into the black page:

| Slice | `browser.ts` | What `index.ts` adds |
|---|---|---|
| `src/shell/transport/` | `client.ts`, `errors.ts`, `wire.ts` | `handshake.ts` (`node:crypto`), `server.ts` (`node:http`) |
| `src/shell/picker/` | everything but `open.ts` | `open.ts` → `src/process/Processes.ts` (`node:crypto`) |

So `src/shell/ui/` and `src/page/` import `../picker/browser.ts` and `../transport/browser.ts`, and
`src/shell/host/effects.ts` — the kernel side — keeps importing `../picker/index.ts`. Adding a
Node-only module to a slice means adding it to `index.ts`, never to `browser.ts`; getting that wrong
reddens the browser project rather than the page.

## The proofs

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

A third mechanic the Pi vertical added (`src/pi/proof/pi-vertical.integration.test.ts`): the desk
stops emitting once the keys stop, so a predicate wait asked for a state that has *already gone past*
blocks until its timeout. Reading "what does it look like now" is a separate move — drain whatever is
queued with a short per-take timeout and keep the last frame (`settled`).

**A proof that reads off the transport says nothing about paint, so a range that renders ships a
browser harness beside it.** jsdom has no layout, so height, scroll and contrast are unfalsifiable in
the unit tier; the harness is what lets a reviewer reproduce a load instead of taking a report for it
(#7610). Two shapes exist and they answer different questions: a Vite page over a test double for one
component (`pnpm proof:chat`, `pnpm proof:pi-window`), and a bin that boots the whole app on a faux
provider and serves the real desk (`pnpm proof:pi-vertical`, `src/pi/proof/serve.ts`) for a claim
about the assembled surface. The second one found `.tuval-window` sizing to its content rather than
to its panel — a 302px window in a 775px panel, transcript 2px — which no headless proof could see.
