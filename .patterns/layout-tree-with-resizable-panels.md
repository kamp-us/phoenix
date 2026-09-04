# Binding a layout tree to `react-resizable-panels`

How Tuval's browser surface renders a tiling layout tree with
[`react-resizable-panels`](https://github.com/bvaughn/react-resizable-panels) v4, and why the
binding is four rules rather than one prop.

Scope: `apps/tuval/src/shell/ui/LayoutView.tsx` and the pure helpers it reads from
`apps/tuval/src/shell/ui/frame.ts`. The library is pinned exactly at `4.12.3` through the workspace
catalog, because three of the four rules below rest on behaviour a range could move.

Every claim here is read off the pinned package in `node_modules/react-resizable-panels/dist/` —
`react-resizable-panels.d.ts` for the API and `react-resizable-panels.js` for the behaviour — and
each is proved by a test in `apps/tuval/src/shell/ui/layout.unit.test.tsx` against the real library.

## The shape

One node of the tree is one component, all the way down:

| Tree | Component | Prop |
|---|---|---|
| `StackNode` | `Group` | `orientation={stack.orientation}` |
| a stack's child | `Panel` | `id={child.id}` |
| between two children | `Separator` | — |
| `LayoutTree.zoomed` | *(no component)* | a conditional render |

The v4 names are `Group` / `Panel` / `Separator`, the prop is `orientation` (not `direction`), the
callback is `onLayoutChanged` (not `onLayout`), and there is no `autoSaveId` and no `order`.

`orientation` is one to one with the tree's own word and needs no inversion: the library's whole
reading of it is `flexDirection: c === "horizontal" ? "row" : "column"`, and `"horizontal"` in
`apps/tuval/src/shell/layout/node.ts` likewise means children side by side. The inversion that does
exist in this repo lives on two command rows (`window:split-vertical` produces a `"horizontal"`
stack, tmux's naming) and stops there.

## Rule 1 — `Panel.id` is the node's id, never its position

`Layout` is `{[panelId: string]: number}` — a map, not an array. Key it by the child's own node id
and a size survives everything that reorders siblings; key it positionally and a split of one
sibling silently re-points every other panel's stored size to a different window.

`defaultLayoutOf` in `frame.ts` builds the map from `stack.sizes`, which the layout tree already
keys by `NodeId`.

## Rule 2 — `defaultLayout` is first paint only; `setLayout` is the write-back

**The library is not prop-controlled.** `defaultLayout` is read once at mount and held through a
stable-object hook; a later value for that prop does not move the DOM. A binding that passed the
kernel's `sizes` as `defaultLayout` and stopped there would paint correctly on load and then never
update — which is exactly the case that matters, because every Tuval tab renders one shared desk and
a drag in one tab has to land in the others.

So the group also carries a `useGroupRef()`, and an effect pushes the kernel's sizes in through
`groupRef.current.setLayout(...)` whenever they differ from what the group holds. `setLayout` applies
after validation and no-ops when the layout already matches, so the effect cannot loop against its
own write.

Compare per key against `SIZE_TOLERANCE` (`sameLayout` in `frame.ts`), never by float equality: a
released drag reports percentages the browser rounded, and an exact test calls every mirror a change.

## Rule 3 — one Msg per gesture, gated on `isUserInteraction`

Use `onLayoutChanged`, which fires once when a gesture completes, and never `onLayoutChange`, which
fires continuously through the drag. Then gate on the meta:

```tsx
const onLayoutChanged = (layout: Record<string, number>, meta: LayoutChangedMeta): void => {
	if (!meta.isUserInteraction) return;
	dispatch({type: "layout.resize", stackId: stack.id, sizes: layout});
};
```

`isUserInteraction` is `true` only for a released pointer drag or a separator resize key, and
`false` for the programmatic `setLayout` of rule 2, the initial mount, a constraint recompute and a
default-size change. Without the gate, rule 2's write-back comes straight back as a Msg and the two
tabs push a layout at each other.

The `layout.resize` cell is in `apps/tuval/src/shell/core/machine.ts`; it writes one stack's sizes
and nothing else.

## Rule 4 — persistence is the kernel's, so never call `useDefaultLayout`

v4 has no `autoSaveId`; persistence is opt-in through `useDefaultLayout`, which reads and writes
`localStorage` under a `react-resizable-panels:<id>` key. Tuval's desk is checkpointed by the kernel
(`apps/tuval/src/durability/`) and every tab renders that one desk, so a per-browser copy of the
layout is a second source of truth that would fight the first on the next reload.

The surface never calls that hook, and `layout.unit.test.tsx` asserts `localStorage` is untouched
after a resize.

## Zoom is a conditional render, never `collapse()`

`LayoutTree.zoomed` names one window; when it is set, render that window alone and unmount the
splits. RRP restores the split from its own panel-id cache on remount, and `zoom` / `unzoom` in
`apps/tuval/src/shell/layout/tree.ts` never write `sizes`, so unzoom lands on exactly the layout the
user left. Collapsing the other panels instead would write sizes, and unzoom would have to guess
what they were.

## The separator's own keys are not a second listener

`Separator` attaches a `keydown` handler to its own element for arrow/Home/End/Enter resizing. A
surface with a "one keyboard listener" rule means one *application-level* listener — the shell's,
on the document — and a test asserting zero others will fail. What the rule protects is that nothing
but the shell listener dispatches `keys.press`.

## Testing it under jsdom

jsdom gives no `ResizeObserver`, no `PointerEvent`, and reports every element as 0×0. RRP refuses to
resize a group it has never measured (`Error: Previous layout not found for panel index 0`), so a
`ResizeObserver` stub that merely records its callback leaves the library permanently unmeasured and
every resize test dead. The observer has to **fire**, once, with a real box.
`apps/tuval/src/shell/ui/dom.testing.ts` is that shim.

With it, a separator's arrow key is a real user gesture through the real library, which is how the
one-Msg-per-gesture claim is proved rather than asserted.
