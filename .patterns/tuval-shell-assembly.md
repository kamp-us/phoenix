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

## A program row's `R` is satisfied at spawn, not by the row

`shellProgram({effects})` needs `Registry`, `Processes` and `ProcessTable` to run `openProgram` and
`attachProcess` — the picker spawns. A row is pure data built before the kernel exists, so it cannot
close over them; it declares them as its `R` instead, and the spawner provides them:

```ts
// src/boot.ts
const launched = yield* launch(compiled, wiring, {services: kernel}).pipe(
  Effect.provideContext(kernel),
);
```

`launch` merges that context into each spawn's `SpawnOptions.services` beside the node's own
`ProcessPorts`. `SpawnOptions.services` is the only seam a program row's requirements can arrive
through, and handing them over is a wiring decision rather than a capability grant — local program
code is fully trusted, there is no sandbox (#7484 R1.1).

**Every spawner hands over that same kernel context, so a program a picker may open may require
kernel services** (#7951). `restore` gets it from `start` for the checkpointed processes the graph
did not plan; the picker passes on the context its own shell process was launched with
(`src/shell/picker/open.ts`). `src/demo/counter.ts` is the example: its `announce` handler wants
`ProcessPorts`, and it comes up under either spawner. What each of those two paths does *not* pass on
is the spawner's own `ProcessPorts` — a port binding emits from one node — so each builds the process
one of its own, un-wired where the graph owns no route (#7789).

**Nothing checks the pairing, so the failure is at the handler.** `SpawnOptions.services` is typed
`Context.Context<never>`, which every context satisfies, so a row asking for a service its spawner
does not hold spawns fine and dies on the first handler that reaches for it. Where the requirement is
visible is the row's own type: `aiAgentProgram` is generic over the leftover requirement of the layer
it is handed (`src/ai-agent/program.ts`), so an agent row over a layer that still needs `SpellBridge`
says `SpellBridge` on its services rather than closing it.

## Which Cmds the kernel runs, and which the surface does

The shell core emits eight Cmds, and the type says which side runs each: `KernelCmd` and `PageCmd`
in `src/shell/core/machine.ts`, with `ShellCmd` defined as their union so a ninth arm has to land on
a side ([ADR 0353](../.decisions/0353-kernel-sends-the-prefix-table.md)).
`src/shell/host/effects.ts` runs three of the five kernel arms and states why the rest are inert:

| Cmd | Who runs it |
|---|---|
| `openProgram`, `attachProcess` | the kernel — `runPickerIntent`, whose answer is the follow-up Msgs |
| `forwardKey` | the kernel — `Processes.handle(id)` then `dispatch({type: "key", key})` |
| `runCommand` | nobody: the name is a user binding the command table does not hold; logged at debug |
| `startRepeatTimer`, `cancelRepeatTimer` | **the surface** — see below |
| `openCommandLine` | the surface — the line is a page element, not a process |
| `reloadConfig` | nobody yet: `Booted.reload` sits above the kernel, out of a handler's reach (#7743) |

**An armed prefix is never timed, and the only countdown is the repeat window's.** tmux waits
indefinitely after its prefix and phoenix follows it (founder ruling on #7842), so `PrefixTable` has
no arm-timeout field, `KeysConfig` has none to merge, and the armed snapshot carries
`repeatWindowMs: null`. The prefix drops on a completed sequence, an unbound key (Escape is one), or
a lapsed repeat window — never on its own. The one bounded window is tmux's `repeat-time`, which a
`repeatable: true` binding opens.

**That countdown is the surface's, and that is structural.** A kernel handler returns its follow-up
Msgs and has no way to dispatch one later, so it cannot run a timer. The snapshot carries the repeat
window's length, so the page runs the countdown off state alone (`Desk.tsx`) — over the table the
kernel sent it, and no other (ADR 0353). Three consequences a caller must hold:

- Anything driving the kernel with no page attached — a test, a script — has to fire
  `{type: "prefix.repeatLapsed"}` itself after a repeatable binding (`<c-h>`, `<c-l>`), which
  deliberately leaves the prefix armed; with no countdown it stays armed, swallowing the next key.
- That Msg disarms **only** a repeat window. A stale one cannot drop a prefix armed by hand, which
  is what keeps the indefinite wait indefinite.
- The countdown's effect must depend on the prefix's **value**, never on the snapshot object. Every
  snapshot arrives freshly decoded, so an effect keyed on `state.prefix` re-arms on unrelated kernel
  traffic and never fires — a demo counter ticking once a second starved it indefinitely (#7782).
  The dispatcher is read through the `latest` ref for the same reason.

## `forwardKey` delivers a program's own `key` Msg

With the prefix unarmed every key belongs to the focused window, and the core answers with a
`forwardKey` Cmd naming the window's process. The host dispatches `{type: "key", key}` into it. A
program that wants the keyboard declares a `key` cell; one that does not simply drops the key at
debug, because a keystroke is not worth ending a desk over and the shell's error channel is `never`.

**One keystroke has two deliveries, and only one of them is the Cmd.** Beside the kernel's dispatch
into the process, the page hands the same key to that window's React renderer — off its own
`surfaceKey` answer, not off a Cmd, because Cmds do not cross the wire. That is why `forwardKey` is
a `KernelCmd` despite the page also acting on the key, and why the walk in
`src/shell/ui/key-agreement.unit.test.ts` compares the two sides' *routing decision* rather than
their Cmd lists.

## What the page can and cannot see

The page reads four things off the wire: the shell process's state, the process table, the **catalog
of windowed programs** (the `registry` frame, #7788), and the **prefix table** (the `keys` frame,
ADR 0353). The catalog is what a page could spawn, never what a process holds, so the frames stay
program-blind: a process's state still crosses as `unknown`.

- The prefix table is the one frame that is neither state nor catalog — it is the grammar the page
  routes keys over, and it may route over no other. `DeskProps.table` is required and
  `AttachedDesk` renders the placeholder until the frame lands, so a page that has been told no
  grammar shows no desk rather than inventing one. `Duration` does not survive JSON, so the frame
  carries `repeatTimeoutMs` and `toWirePrefixTable`/`fromWirePrefixTable` convert.

- The kernel decides what is in the catalog, and it decides with `showsInAWindow`
  (`src/shell/picker/entries.ts`) — the one place the headless test lives. A row with no `renderer`
  never crosses, so `WireProgram.renderer` is required and a page cannot be offered a program it
  would then fail to render.
- The page's renderer table (`src/page/renderers.tsx`) is keyed by the `RendererRef.ref` a row
  declares, and `resolverFromTable` (`src/shell/window/renderer.ts`) resolves it — kind checked, so
  an `isolated-frame` reference is never answered by the `host-native` renderer of the same name. A
  fourth windowed program that names a reference this table already answers needs no edit here.
- The page's picker offers both sections: every windowed program, and every running process. Opening
  by name still works through `prefix : window:open <program>`, and both routes end in the same
  `window.open` Msg, so the picker and the command line cannot drift into two spawn paths.
- **The kernel pushes the catalog; the page never asks.** A spell call is the only page-to-kernel
  message (#7617 R1.3), so the catalog goes out as the socket opens and again on
  `TransportServer.publishRegistry`, which re-reads the registry and writes to every attached page.
  Nothing calls it in production, and a call would change nothing: `Registry.layer` builds one frozen
  map, so the catalog is fixed for the life of the kernel process and every publish would re-send
  what the socket already got on open (#7841). `Booted.reload` writes only the spell registry
  (#7743).

`AttachedDesk` opens **one subscription per process**, so two windows over one process are one state
with two view slots — the Vim buffer model (#7484 R1.3), not two copies.

## A windowed program: the reference, the shared window, the extras slot

Three files, and the split between them is forced rather than stylistic.

- **The row names the window and reaches none of it.** A row is kernel-side data and must stay free
  of React, so the `RendererRef` it declares lives on a leaf that imports one type and nothing else
  — `src/pi/renderer-ref.ts` for `pi-session`, `src/claude/renderer-ref.ts` for `claude-session`.
  Retyping the name at both ends instead would drift
  silently: an unresolved reference is a returned value, never a throw
  (`src/shell/window/renderer.ts`), so the window comes up blank and nothing fails.
- **That leaf sits beside the row, not inside the renderer's directory.** The strict lens
  (`tsconfig.json`) is `composite` and must list every file it compiles, and a renderer directory is
  excluded from it whole because it imports `@kampus/design`, which needs the relaxed lens
  (`tsconfig.design.json`). A file the row imports out of an excluded directory is a `TS6307` on
  every build.
- **The leaf carries the program id too, and both names are imported rather than retyped.** The
  page's table keys on the `RendererRef.ref` the row declares (`src/page/renderers.tsx`), and it
  reads that reference off the leaf through `src/pi/window/index.ts`. The program id sits on the
  same leaf for the same reason: importing it from the row would pull `node:path` and Pi's model
  runtime into the page bundle, which is the black page of #7836 — so `PI_SESSION_PROGRAM` is
  declared on the leaf and `src/pi/program.ts` re-exports it.
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
  (`src/pi/window/PiChatWindow.tsx`); Claude's is that line plus a session line — session id and
  cwd, off `state.sessionId` and `state.cwd` (`src/claude/window/ClaudeChatWindow.tsx`). Each
  renderer directory is named in `tsconfig.json`'s `exclude` and `tsconfig.design.json`'s `include`,
  for the lens reason above. It is a function of the live state because a renderer *is*
  `f(state, view)`; a renderer that accumulated its own totals would disagree with the checkpoint
  and with the other window over the same process. Wrapping the shared window in a program-specific
  container is the wrong shape for a second reason: `chat.css` re-declares the `@kampus/design`
  typography roles inside `.tuval-chat`, so a package primitive mounted *outside* that scope reads
  Tuval's two-part `--t-*` values as invalid shorthand and loses its whole `font` declaration.

## A program declares three renderers; the shell composes two of them

A program never draws outside its own window (#7500 ruling 4). The two surfaces outside it — the
desk inspector beside the tiling area, and the middle of the status bar — are therefore renderers a
program *declares* and the shell composes from the Snapshot, never regions a program pushes into.
The row carries three optional references (`src/registry/program.ts`): `renderer` for its window,
`inspector`, and `status`.

- The two desk renderers take the same `WindowHost` the window renderer takes, so all three are
  transport-blind and all three read the program's selection state out of the one process the
  focused window shows.
- **An inspector renders whatever its surface renders**, so its output is a free `Out`, exactly like
  a window renderer's. **A status renderer returns segments**, a fixed `{id, text, tone?}` list — not
  a bar. That is the ruling as a type: the shell owns the left (the workspace) and the right (kernel
  facts) because `statusFor` derives them itself and a program's segments can only ever arrive in
  `middle` (#7500 ruling 5).
- `inspectorFor` and `statusFor` (`src/shell/desk/compose.ts`) walk one chain — focused window → its
  process → its program row → the reference it declares → the renderer that reference names — and
  answer with a value on every step that does not resolve (`DeskEmptyReason`). A region is never a
  hole and never a throw; the surface renders its placeholder and reads nothing else.
- **The inspector's open/collapsed flag is desk state, not workspace state**: it lives on
  `ShellState.desk` (`src/shell/desk/state.ts`), so a workspace switch leaves it exactly as it was.
  `desk.inspector.toggle` is the one Msg that writes it, reachable from the `desk:inspector-toggle`
  command row like any other.
- `src/shell/desk/` imports no socket, no React and nothing from `src/shell/ui/` — its own boundary
  test is the gate, as `src/shell/window/`'s is.

## Two error boundaries, and what each one is allowed to cost

A render throw with nothing above it unmounts React's whole tree, and on this surface that is a
black tab with the reason only in a console nobody is reading. It has cost the project twice —
#7560, then a `<c-b> |` that took the desk down on its own headline key
([#7839](https://github.com/kamp-us/phoenix/issues/7839)). `ErrorBoundary` in
`src/shell/ui/ErrorBoundary.tsx` is the answer, and it is mounted in exactly two places, each sized
to what a throw there may cost:

| Where | Wraps | What survives |
|---|---|---|
| `Desk.tsx` | the tiling area alone | the status line, the command line, the desk's keyboard |
| `main.tsx` | everything the page renders | the tab, with the reason on it |

**Recovery is not a button that re-throws.** The boundary takes `resetKeys`, and the desk hands it
`layoutSignature(workspace.layout)` — the layout tree serialized to one string
(`src/shell/layout/tree.ts`) — so the next kernel snapshot that changes the layout clears the panel
with no gesture at all. The button is the fallback for the case where nothing new arrives.

**The key is a signature and never the layout object**, and that is the whole rule for anything else
mounting this boundary: `resetKeys` are compared with `Object.is`, and every snapshot the page
receives is decoded afresh, so a tree object is a new identity on every frame whether or not
anything moved. Keyed on the object, the panel is unmounted and rebuilt on unrelated kernel traffic
— `<details>` snaps shut, focus on the reset button is lost with the node, and `role="alert"`
re-announces once per frame, which is the reader's whole recovery gone in the exact case the panel
exists for. It is the same identity trap the desk's prefix countdown avoids by depending on the
prefix's *values* (#7782); `error-boundary.unit.test.tsx` drives the boundary with JSON-decoded
snapshots to pin it.

The panel is a `role="alert"` carrying the throw's own message plus its component stack in a
`<details>`, because the reason a founder can paste is the point; showing "something went wrong" is
the failure mode again in nicer words.

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

## The design layer on the page

`apps/tuval` consumes `@kampus/design`, and three things about that are not obvious from the import.

**Three stylesheets, in this order, in `src/page/main.tsx`.** Manti's base first
(`@manti-ui/styles/index.css`) — a `@kampus/design` primitive *is* a Manti component, and without the
base its dialog has no positioning at all and lands in the document flow, which is what a palette
rendered full-width at the bottom of the desk looks like. Then `@kampus/design`'s fonts and tokens,
then `src/shell/ui/tokens.css`. The last two both declare role tokens at `:root`, and the desk's own
values have to win that tie, which is what the order buys.

**The theme is two attributes on `index.html`.** `data-theme="dark"` and
`data-color-theme="indigo"`. The desk is dark-only window chrome — there is no light branch and
nothing reads `prefers-color-scheme` — and `indigo` is the accent nearest the desk's own blue, so the
palette and the surface behind it read as one system. A component sets neither: it inherits.

**`exactOptionalPropertyTypes` is off in both tsconfigs, and it is not a preference.** The
`@manti-ui/react` declarations spell an optional prop `foo?: T` where React's own attribute types
spell `foo?: T | undefined`. Turning the flag back on gives 8 errors on each lens, and all 8 are in
`packages/design/src` — `AgentChatInput.tsx` (×3), `Avatar.tsx`, `Button.tsx`, `CommandPalette.tsx`,
`CountToggle.tsx`, `Switch.tsx` — measured with `tsc -p <lens> --exactOptionalPropertyTypes` at
#7851's head. `apps/web/tsconfig.app.json` turns it off for the same cause, and
[#7856](https://github.com/kamp-us/phoenix/issues/7856) is where it goes back on: fix those sources,
then drop the opt-out in all three consumers.

**An optional prop authored here spells its own `| undefined`**, so no `apps/tuval` file rides the
loosened rule and the count above stays a design-package number. `PaletteProps.window` was the one
that did not, and it put two `apps/tuval` files into that list until #7851 widened it. If you hit a
TS2375 in your own file under the flag, it is yours to fix at the prop, not something this section
excuses. The optional-key idiom (`...(x === undefined ? {} : {x})`) is still the shape every module
here is written in.

A slice that is browser-only end to end keeps one `index.ts` rather than the `index.ts`/`browser.ts`
pair a *shared* slice needs; `src/palette/` is the one today. What still binds it is the rule above:
no module the page reaches may import `node:*`, and `tsconfig.browser.json` is what says so.

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

Two more mechanics the Claude vertical added
(`apps/tuval/src/claude/proof/claude-vertical.integration.test.ts`).

**Keep a log beside the queue when the claim is about the whole sequence.** A predicate wait consumes
frames, so "the card opened and closed exactly once" cannot be asked of the queue afterwards — the
frames that would answer it are gone. The watcher pushes each published value into an array as well
as the queue, and the count is taken off the array at the end.

**Standing a second `SpellExecutor` up over a booted kernel needs two deliberate moves.** A proof that
must resolve a caller's window — to parent a `process spawn`, say — supplies its own `WindowIndex`,
because `boot` builds that index empty until the shell owns one (#7894). Composing it with
`Layer.provide` does not work and does not look broken: `SpellExecutor.layer` is one module-level
`Layer` value `boot` has already built, so the build hands back the memoized executor holding the
empty index, and every call answers `NoSuchWindow` while the wiring reads correct. Wrap it in
`Layer.fresh`, and merge the contexts one step at a time — `Context.merge(self, that)` lets `that`
override, so each step names its winner rather than leaving it to composition order.
