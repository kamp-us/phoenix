# A window renderer refuses the state it cannot read

**Reference.** How a Tuval window renderer is admitted onto a process's state, and why a renderer
never sees a state nothing checked.

## The rule

Two invariants, both held in code rather than by review:

1. **Every entry in a page's renderer table declares the predicate over the state it reads.** The
   table's value type is `ReadableRenderer` (`apps/tuval/src/page/readable-state.tsx`). It carries a
   module-private `unique symbol` field, so only `readsState(predicate, renderer)` can mint one — a
   renderer put in the table unguarded does not typecheck, and neither does an entry written by hand
   with an `admits` of its own. The predicate's `S` is the renderer's own `S`, so a renderer paired
   with another program's predicate does not typecheck either (`TS2345`).

   Brand it, do not merely document it: a structural interface makes the sentence "only `readsState`
   mints one" a claim a reader leans on and the compiler does not hold. The `@ts-expect-error` case
   in `readable-state.unit.test.tsx` is what keeps the brand from being quietly removed — that
   directive going unused is itself a type error.
2. **Every window renders inside its own error boundary.** `WindowView` wraps `mount.render` in an
   `ErrorBoundary` labelled by the process (`apps/tuval/src/shell/ui/WindowView.tsx`), so a renderer
   that throws anyway costs that one window and not the desk.

## Why

The wire carries whatever the kernel on the other end holds, and in dev that kernel can predate the
browser by a state-shape commit: the page hot-reloads, the kernel does not. A renderer typed against
the new shape then reads a field the old shape has no key for and throws inside React's render —
the one fault a window cannot show for itself, because React unmounts up to the nearest boundary.
With the desk-level boundary as the only one, that unmount took every window with it (#8157).

The refusal half is the shape the checkpoint path already had: `loadCheckpoint` refuses an
unreadable checkpoint into `gone` carrying `checkpointUnreadable` rather than opening silently over
it (`apps/tuval/src/ai-agent/core/snapshot.ts`, #8095, #7514). An unreadable state is shown and
named, never guessed at and never silently empty. This applies that same predicate to the live wire.

## Shape

```tsx
export const pageRenderers: Readonly<Record<string, ReadableRenderer>> = {
	"tuval/demo/counter": readsState(isCounterState, counterRenderer),
	[CLAUDE_CHAT_WINDOW_REF.ref]: readsState(isAiAgentSessionState, ClaudeChatWindow),
};
```

`readsState` returns a renderer whose `render` mounts `ReadableWindow`, which subscribes to
`host.readProcess` itself and holds three states:

- **`unknown`** — no view has arrived. Renders the pending line. The inner renderer is *not*
  mounted, which is what keeps a skewed state a refusal instead of a race: a renderer mounted first
  would subscribe to the same stream and read the bad state before the guard's own update landed.
- **`unreadable`** — a `Live` view whose state the predicate refused. Renders a `role="alert"`
  naming the process and the action that clears it (restart the kernel).
- **`readable`** — mounts the renderer. A `ProcessGone` view counts as readable: the gone arm is the
  window contract's own (`apps/tuval/src/shell/window/host.ts`), read back by the renderer.

The predicate belongs to the program whose state it is — `isCounterState` in `demo/counter.ts`,
`isAiAgentSessionState` in `ai-agent/core/snapshot.ts` — never to the page. The page only pairs it
with the renderer.

A renderer the page loads from a module (`kind: "module"`, ADR 0359) is seated the same way: the
module exports `admits` beside its `default` renderer, and `loadModuleRenderers`
(`apps/tuval/src/page/module-renderers.ts`) passes the pair through `readsState`. A module with no
`admits` is a load failure in the table, not an unguarded entry.

## The one entry that admits everything: an authored window

A window written with `defineProgram({window})` is compiled into a renderer whose `render` answers
`(state) => Out` rather than a node, and `apps/tuval/src/page/authored-windows.tsx` is what adapts
it into a table entry: it subscribes for the state and calls the author's function per state, then
mints the entry through `readsState` like every other (#8811).

**The predicate it passes admits any state, and that is deliberate.** An authored program declares
none — the authoring API's premise is that `window` alone draws a window — so the page has nothing
to pair, and inventing a predicate here would be the page guessing at a program's shape, which the
rule above forbids. So invariant 1 holds for an authored entry only in form: it carries an `admits`
and it is minted by `readsState`, but that `admits` refuses nothing.

What bounds the cost is invariant 2. An authored window reading a state a stale kernel still sends
throws inside React's render and is caught by its own `ErrorBoundary`, so it costs that one window
and the desk keeps the rest — the #8157 fault stays closed, and only its named refusal is missing.
`admitsAnyState` is a named predicate rather than an inline `() => true` so the weaker guarantee
reads off the code, and so a declared predicate has one seat to land in if the authoring API ever
grows a way to write one.

Read this before asserting that *every* entry in `pageRenderers` refuses an unknown state:
`readable-state.unit.test.tsx` does assert that, and it holds because no program is authored in that
test's process. It is a claim about the page's own entries, not about the table's whole range.

## The boundary's reset keys

`resetKeys={[mount.host.processId]}`, and nothing that moves per render. The boundary compares keys
with `Object.is`, so a key rebuilt on every snapshot would tear the panel down under the reader
mid-sentence — the failure `Desk.tsx`'s layout *signature* exists to avoid (#7839). A window still
bound to the process that threw therefore keeps its panel until the founder presses the panel's own
button, and the windows beside it were never affected.

## Testing it

Both halves are proved through a desk, because the cost being tested is what is still on the surface
after one window fails:

- `apps/tuval/src/page/readable-state.unit.test.tsx` — a process holding the pre-#8006 permission
  shape renders the refusal in its own window while the sibling window still shows its state; the
  table's every entry carries an `admits`; a hand-written entry is not a `ReadableRenderer`.
- `apps/tuval/src/shell/ui/error-boundary.unit.test.tsx` — one window's renderer throwing leaves the
  sibling rendered, the failed window's title and frame in place, and the status line alive.
- `apps/tuval/src/page/authored-windows.unit.test.tsx` — an authored `window` is seated under the
  reference its own row declares, the page's table resolves that reference, and re-compiling the
  program replaces the one seat. It also checks the namespace the merge rests on: `pageRenderers`
  writes `pageOwnRenderers`'s keys after the authored ones, so a page key ending in
  `AUTHORED_WINDOW_SUFFIX` would shadow an authored seat in silence. Flip-verify by dropping the
  merge in `renderers.tsx`: the resolution falls back to `unknown-ref`.

Flip-verify both: drop the predicate check and the stale-shape test fails with the original
`Cannot read properties of undefined (reading 'status')`; drop the per-window boundary and the
sibling-survival tests fail.
