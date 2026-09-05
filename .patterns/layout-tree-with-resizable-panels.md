# Binding a layout tree to `react-resizable-panels`

How Tuval's browser surface renders a tiling layout tree with
[`react-resizable-panels`](https://github.com/bvaughn/react-resizable-panels) v4, and why the
binding is six rules rather than one prop.

Scope: `apps/tuval/src/shell/ui/LayoutView.tsx` and the pure helpers it reads from
`apps/tuval/src/shell/ui/frame.ts`. The library is pinned exactly at `4.12.3` through the workspace
catalog, because most of the rules below rest on behaviour a range could move.

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

**The library is not prop-controlled *within one panel set*.** `defaultLayout` is read when the group
registers and held through a stable-object hook; a later value for that prop does not move the DOM
while the panels stay the same. A binding that passed the kernel's `sizes` as `defaultLayout` and
stopped there would paint correctly on load and then never update — which is exactly the case that
matters, because every Tuval tab renders one shared desk and a drag in one tab has to land in the
others.

So the group also carries a `useGroupRef()`, and an effect pushes the kernel's sizes in through
`groupRef.current.setLayout(...)` whenever they differ from what the group holds. `setLayout` applies
after validation and no-ops when the layout already matches, so the effect cannot loop against its
own write.

Compare per key against `SIZE_TOLERANCE` (`sameLayout` in `frame.ts`), never by float equality: a
released drag reports percentages the browser rounded, and an exact test calls every mirror a change.

### 2a — never `setLayout` a panel set the group does not hold; let `defaultLayout` carry that

`setLayout` is not total, and the one thing it will not tolerate is a layout naming a different
number of panels than the group has registered. Its validator opens with exactly that check
(`dist/react-resizable-panels.js`, `validatePanelGroupLayout` — the minified `X`):

```js
if (o.length !== t.length)
  throw Error(`Invalid ${t.length} panel layout: ${o.map((a) => `${a}%`).join(", ")}`);
```

`t` is the group's `derivedPanelConstraints`, one entry per registered `Panel`. So a write for a set
the group has not caught up to is a **throw**, not a no-op, and with no boundary above it that throw
unmounts the desk. `sameLayout` cannot see it: it walks `stack.children` and treats a `reported[id]`
of `undefined` as agreement, so a child the group has never heard of scores `true`.

**And there is nothing to write anyway.** Registration takes the group's layout from
`e.mutableState.layouts[panelIds] ?? e.mutableState.defaultLayout ?? evenSplit(constraints)` (same
file, the group-registration function — the minified `Wt`), and `mutableState.defaultLayout` is
refreshed from the `defaultLayout` **prop** by an effect that runs on every commit. For a panel set
the group has not laid out before — which is every set a split or a close produces — the current
`defaultLayout` prop *is* what it adopts. Passing `defaultLayoutOf(stack)` on every render is
therefore the whole binding across a panel-set change, and `layout.unit.test.tsx` proves it by
splitting an 80/20 stack and reading the resulting three `flexGrow`s back off the DOM.

So the effect asks two questions in this order, and `LayoutView.tsx` is those two lines:

```tsx
const reported = group.getLayout();
if (!holdsPanels(stack, reported)) return;               // the set changed — defaultLayout has it
if (sameLayout(stack, reported, SIZE_TOLERANCE)) return; // the sizes agree — nothing to push
group.setLayout(defaultLayoutOf(stack));
```

**Why the group is ever behind, given that React commits the new `Panel` first.** A mounting `Panel`
registers in a layout effect, and registration only calls the group's force-update — so the group's
own registration effect, which is what recomputes `derivedPanelConstraints`, does not re-run until
the *next* commit. `StackView`'s passive effect fires in between. The exception is a change to a
prop that registration effect already depends on: `orientation` is one, which is why `<c-b> -` on a
one-window stack never crashed while `<c-b> |` and `<c-b> x` always did — `-` flips the stack's axis,
so that group re-registers in the same commit ([#7839](https://github.com/kamp-us/phoenix/issues/7839)).
Nothing in this rule rests on that accident; the guard covers all three the same way.

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

## Rule 5 — a size prop's unit is its JSX form: a string is percent, braces are pixels

`minSize` and `maxSize` read their unit off the value's *type*, and the library's own `PanelProps`
docblock is the rule: "Numbers are interpreted as pixels … Strings without explicit units are
interpreted as percentage … Use explicit units (`px`, `%`, `em`, `rem`, `vh`, `vw`) to change
interpretation" (`react-resizable-panels@4.12.3`, `dist/react-resizable-panels.d.ts`, `minSize`).

So `minSize="10"` is ten **percent** and `minSize={10}` is ten **pixels**. In JSX the two differ by
two characters and read the same aloud, so the quotes are load-bearing. `LayoutView.tsx` passes
`minSize="10"` — a window may not be squeezed below a tenth of its stack — and quietly switching it
to braces would allow a ten-pixel sliver
([#7783](https://github.com/kamp-us/phoenix/issues/7783)).

## Rule 6 — the separator's state is `data-separator`, and its grab region is a Group prop

The separator's hover/drag/focus styling hangs off one attribute, `data-separator`, whose value at
this pin is the state — `inactive`, `hover`, `focus`, `active` or `disabled`. Read that off
`dist/react-resizable-panels.js` (`Separator`, the `data-separator: G` prop), not off the `.d.ts`,
whose `SeparatorProps.id` docblock says the value is the separator's id; the runtime writes the id
to `id` and `data-testid` and the state here. There is no `data-resize-handle-active` at v4 — that
name is a v2 handle attribute, and a stylesheet carrying it paints nothing
([#7499](https://github.com/kamp-us/phoenix/issues/7499)).

The element also has no width or height of its own: the library's inline style is `flexBasis:
"auto"` with `flexGrow: 0` / `flexShrink: 0`, and it renders no children. So the stylesheet gives it
one — `apps/tuval/src/shell/ui/tokens.css` sizes it per `aria-orientation`, which the library sets
to the axis *across* the group (`"vertical"` inside a horizontal group).

Sizing it thin is the right look and the wrong hit target, and the two are separable: `Group`'s
`resizeTargetMinimumSize` inflates the *grab rect* independently of the painted box, defaulting to
`{coarse: 20, fine: 10}`. `LayoutView.tsx` raises it to `{coarse: 36, fine: 24}` so a 4px hairline
is still a real pointer and touch target.

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
