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
`apps/web/src/components/ui/Dialog.test.tsx` and
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

## Related

- [property-based-a11y.md](./property-based-a11y.md) — the other `ui/` test surface; it
  asserts static structure, so it needs no flush.
- [unconditional-test-assertions.md](./unconditional-test-assertions.md) — the sibling
  silent-pass shape.
