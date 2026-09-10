# Testing a Manti/Zag primitive's interaction — flush microtasks before you assert

Every Manti (`@manti-ui/react`) primitive is driven by a Zag state machine through
`useMachine` from `@zag-js/react`. **A Zag machine never transitions in the same
synchronous tick as the event that triggered it.** So a `client`-tier test that clicks and
asserts in one tick asserts nothing about the component — and for a checkbox-backed control
like `Switch` it can go green on jsdom's own native checkbox toggle instead.

```tsx
// VACUOUS — onCheckedChange has not been called yet, and never will be by this tick.
fireEvent.click(input);
expect(onCheckedChange).toHaveBeenCalled(); // reds
expect(input.checked).toBe(true);           // greens, but that is jsdom's native toggle
```

```tsx
// CORRECT — one microtask flush, then the machine's transition is observable.
await act(async () => {
	fireEvent.click(input);
});
expect(onCheckedChange).toHaveBeenCalledWith(true);
expect(control.getAttribute("data-state")).toBe("checked");
```

`await waitFor(...)` works too, and is what the already-correct tests in
`packages/design/src/Dialog.test.tsx` and
`apps/web/src/components/bildirim/BildirimPopover.test.tsx` rely on. Prefer `act` when you
know the machine settles in one microtask; reach for `waitFor` when a later async source
(a fate mutation resolving, a `useEffect` chain) also has to land.

## Why — the deferral is in `useMachine`, not in jsdom

`@zag-js/react@1.43.0`, `dist/machine.mjs`: `send` wraps its whole body in a
`queueMicrotask`, and bails early unless the machine's status is already `Started`:

```js
const send = useStableFn((event) => {
  queueMicrotask(() => {
    if (statusRef.current !== MachineStatus.Started) return;
    // …find the transition, run the actions
  });
});
```

The machine's own start is a second `queueMicrotask`, scheduled from a layout effect. So
between `render()` and the first observable transition there are always at least two
microtask boundaries, none of which a synchronous assertion crosses.

The machine's DOM handler itself is **not** the problem: `getHiddenInputProps().onClick`
(`@zag-js/switch@1.43.0`, `dist/switch.connect.mjs`) is attached to the node and runs
synchronously on the click, sending `CHECKED.SET`. Only the transition it sends is deferred.

Three candidate causes are ruled out by a bare `@zag-js/react` + switch-machine repro that
uses no Manti at all and reproduces identically:

- **not** Manti's `mergeProps` over consumer `inputProps` — the bare repro spreads
  `getHiddenInputProps()` straight onto the input and behaves the same;
- **not** a Zag/React-19 interaction — the deferral is unconditional library code;
- **not** jsdom's synthetic-event or `isTrusted` handling — React delivers the click, the
  machine's handler runs, and the transition lands on the very next microtask.

## Real browsers behave the same, and it does not matter there

`queueMicrotask` has no environment branch, so a real browser defers the transition by
exactly one microtask too. A microtask drains before the next paint and before any
subsequent task, so no user can observe the intermediate state. **This is a test-authoring
constraint, not a product bug — and not a reason to push machine-driven interaction out of
the `client` tier into Playwright.** jsdom exercises these machines correctly once the flush
is there.

## Blast radius — every Manti primitive

All Manti components go through the same `useMachine`. Measured under jsdom, click →
synchronous read → flush → read:

| Primitive | Synchronous read after the click | After one microtask flush |
|---|---|---|
| `Switch` | `onCheckedChange` not called, `data-state="unchecked"` | called with `true`, `data-state="checked"` |
| `Menu` | trigger `data-state="closed"` | `data-state="open"` |
| `Tabs` | `aria-selected="false"` on the clicked trigger | `aria-selected="true"` |
| `ToggleGroup` | `onValueChange` not called | called with `["a"]` |
| `Dialog` | `onOpenChange` not called | called with `false` |

Treat any Manti primitive the same way, whether or not it is listed here.

## The mirror image — Zag also schedules work *after* the unmount

The same deferral runs past the end of a test, and there it is the tier's problem rather than
yours. Two Zag paths outlive the unmount that should have ended them, because nothing cancels
them: `@zag-js/dialog`'s `checkRenderedElements` action discards the cancel handle `raf()` hands
back, and `@zag-js/focus-trap`'s `deactivate()` restores focus on a `setTimeout(fn, 0)`. Both
resolve their root through `@zag-js/core` `createScope`, whose `props.getRootNode?.() ?? document`
is a bare global read — so once Vitest tears the jsdom environment down at the end of a file, that
read throws `ReferenceError: document is not defined` rather than yielding `undefined`, and Vitest
collects it as an unhandled error that reds a fully-green run.

`packages/design/test-setup.ts` drains those queues in an `afterAll` — two animation frames
(`raf.mjs`'s `nextTick` double-nests) plus one macrotask — so the work runs inside the
environment's life. **You inherit this; do not re-solve it per test.** What it means for you: a
`client`-tier test may leave Zag work pending without reding the run, but a test that deletes or
stubs `document` itself still has to restore it before its own teardown.

A third path escapes the same way, and it is the one an app outside `packages/design` meets first:
opening a **popup** primitive (`Select`, `Menu`, `Popover`, `Dialog`) schedules
`@zag-js/popper`'s `getPlacement` inside a `raf`, which calls `@floating-ui/dom`'s `autoUpdate`,
which constructs an `IntersectionObserver`. jsdom ships none, so the deferred call throws
`ReferenceError: IntersectionObserver is not defined` after the test that opened the popup has
ended, and Vitest collects it as an unhandled rejection against an otherwise-green run. A no-op
`IntersectionObserver` on `globalThis` is the whole fix — nothing asserts a popup's position, and
jsdom has no layout to observe a change in. `apps/tuval/src/shell/ui/dom.testing.ts` installs one
beside its other shims. `packages/design/test-setup.ts` shims `ResizeObserver` and not this one, so
a design test that opens a popup and unmounts it has the same exposure.

## Related

- [property-based-a11y.md](./property-based-a11y.md) — the other `@kampus/design` test surface; it
  asserts static structure, so it needs no flush.
- [unconditional-test-assertions.md](./unconditional-test-assertions.md) — the sibling
  silent-pass shape.
