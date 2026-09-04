# Manti accessibility — the name comes from a prop, and the four times you write one by hand

phoenix's UI primitives are **Manti** (`@manti-ui/react`), and every Manti primitive is driven by a
**Zag** state machine (`@zag-js/*`). Zag wires roles, the disclosure/popup relationships and focus
management itself, so you never hand-write those. What it does **not** do is invent a name.

**The one thing to carry out of this doc:** a Manti primitive's accessible name comes from a
**prop** — `title`, `content`, `items[].label` — not from what you nest inside it. Manti's
components are flat, not compound: there is no `Dialog.Title` to render. So the question at a call
site is never "did I wrap the right child", it is "did I pass the naming prop". An `aria-label` is
what you reach for only when no naming prop exists and the control has no naming text of its own.

Ground truth is `@manti-ui/react@0.9.0` (`dist/index.js`, `dist/components/*/*.d.ts`) and the
`@zag-js/*@1.43.0` connect files it drives, plus the wrappers in `packages/design/src/`;
when this doc and that source disagree, fix the doc. Manti's `@manti-ui/folds` re-exports the Zag
machines unchanged (`export * as switchMachine from '@zag-js/switch'`), so a Zag connect file is
the real behavior.

## What Zag wires for you (don't re-supply it)

Each row was read against the cited source. Claims the source did not confirm were dropped rather
than carried over — notably Zag's tooltip `aria-label` branch, which strips `role="tooltip"` and
sets no label anywhere, and which Manti never reaches.

| Primitive | Zag wires automatically | Where the accessible **name** comes from | Source |
|---|---|---|---|
| `Dialog` | trigger `aria-haspopup`/`aria-expanded`/`aria-controls`; content `role`, `aria-modal`, and `aria-labelledby`/`aria-describedby` id-synced to the rendered title/description parts | the **`title` prop**. There is no other route — `DialogProps` declares no `aria-label` | `@zag-js/dialog` `dialog.connect.mjs` `getContentProps`; `Dialog.d.ts` |
| `Popover` | trigger, same three; content `role="dialog"`, `aria-modal`, the same title/description id-sync | the **`title` prop** | `@zag-js/popover` `popover.connect.mjs` `getContentProps` |
| `Menu` | trigger `aria-haspopup`/`aria-controls`/`aria-expanded`; content `role`, `aria-activedescendant`, and `aria-labelledby` → the trigger's id; item `role="menuitem"`, `aria-disabled` | panel: the trigger's text, or Manti's `ariaLabel` prop. Item: its **`items[].label`** — this *is* the name | `@zag-js/menu` `menu.connect.mjs`; `Menu.test.tsx` asserts `getByRole("menuitem", {name: "Bildirimler"})` |
| `Collapsible` | trigger `aria-controls` + `aria-expanded`, and nothing else. The content part gets no `role` and no labelling | the **`trigger` prop's** own content — the relationship is wired, the name is not | `@zag-js/collapsible` `collapsible.connect.mjs` `getTriggerProps` |
| `Tooltip` | trigger `aria-describedby` while open; content `role="tooltip"` + id | n/a — a tooltip is a *description*. The trigger keeps its own name; Manti wraps it rather than replacing it | `@zag-js/tooltip` `tooltip.connect.mjs`; `Tooltip.test.tsx` reads the trigger as `.parentElement` |
| `Switch` | thumb and control `aria-hidden`; hidden input `role="switch"` + `aria-labelledby` → the label part | the **child** you pass, which Manti renders as the label part | `@zag-js/switch` `switch.connect.mjs` `getHiddenInputProps`; `@manti-ui/react` `dist/index.js` |
| `ToggleGroup` | root `role="radiogroup"` (single) or `"group"`; item `role="radio"` + `aria-checked`, or `aria-pressed` | each item from its `items[].label`. **The group itself gets no name** — Zag's root sets neither `aria-label` nor `aria-labelledby` | `@zag-js/toggle-group` `toggle-group.connect.mjs` |
| `Toast` | region `role="region"` + `aria-live="polite"`; each toast `role="status"`, `aria-atomic`, title/description id-sync | the `title`/`description` you raise through `useToast` | `@zag-js/toast` `toast-group.connect.mjs`, `toast.connect.mjs` |

Two mechanisms are worth knowing because they explain the failure modes below.

**Title id-sync is a DOM probe, not a render-time flag.** `Dialog`/`Popover` decide whether to emit
`aria-labelledby` by *looking for the title element* one animation frame after open — `@zag-js/dialog`
`dialog.machine.mjs`:

```js
      checkRenderedElements({ context, scope }) {
        raf(() => {
          context.set("rendered", {
            title: !!dom.getTitleEl(scope),
            description: !!dom.getDescriptionEl(scope)
          });
        });
      },
```

Pass no `title` and the link resolves to nothing — the dialog is simply unnamed.

**An explicit `aria-label` suppresses the id link on `Dialog`.** The conditional is literal
(`dialog.connect.mjs`):

```js
        "aria-label": ariaLabel || void 0,
        "aria-labelledby": ariaLabel || !rendered.title ? void 0 : dom.getTitleId(scope),
```

Manti's `DialogProps` exposes no `aria-label`, so from phoenix this branch is unreachable — but it
is why "supply a title, not a label" is the rule rather than a preference. `Switch` has the same
suppression one layer up: Manti drops Zag's `aria-labelledby` when you pass `aria-label` or
`aria-labelledby` through `inputProps`.

```tsx
// packages/design/src/Dialog.test.tsx — the flat API. `title` IS the accessible name.
<Dialog open title="başlık" description="açıklama" footer={<Button>tamam</Button>}>
	<p>gövde</p>
</Dialog>
```

### Two places the primitives leave a control unnamed

- **`Dialog`'s close button has no accessible name.** Zag's `getCloseTriggerProps` emits only
  `id`/`type`/`onClick`, Manti renders an `aria-hidden` X inside it, and `DialogProps` offers no
  label prop. (`Popover`'s close button is fine — Zag defaults it to `"close"`.) Tracked in
  [#6776](https://github.com/kamp-us/phoenix/issues/6776); don't work around it per call site.
- **A `ToggleGroup` root is an unnamed `radiogroup`.** Name it from outside — `PropKnobs.tsx` wraps
  each in a `<fieldset aria-labelledby={labelId}>`, which is the shape to copy.

## Nothing invents a name for a control with no naming text

Zag wires *relationships and roles*, but a name is always the element's own text or an explicit
attribute. So when a control's only content is a glyph — or text that identifies nothing, like a
bare vote count or `[ + ]` — there is no name to derive and you must supply one.

`Button`'s `icon` slot renders `aria-hidden="true"`, and `Icon` is `aria-hidden` unless you pass it
a `label`. Both are deliberate: a decorative glyph must not leak into the name. The consequence is
that **`iconOnly` always implies a hand-authored name** — all four `iconOnly` call sites in
`apps/web/src` carry one.

## The decision

```
Does the primitive take a naming prop (title / content / items[].label)?
├─ yes → pass it. NO aria-label — for Dialog it would suppress the title link.
└─ no  → does the control have visible text that names it?
         ├─ yes → nothing to do; the text is the name.
         └─ no  → it needs one. In priority order:
                  1. near a visible heading → aria-labelledby={headingId} (point at the text)
                  2. genuinely nothing to point at → aria-label="<turkish label>"
```

A bare number or a punctuation glyph is **not** naming text. The pano vote button shows a score
beside its triangle and still carries a label, because "3" names nothing.

Casing on a hand-authored label doesn't matter (`"Kapat"` is fine) — it is read, not shown. What
matters is that it exists only where nothing else supplies a name.

## The four legitimate hand-authored-label cases

Every `aria-label`/`aria-labelledby` in `apps/web/src` is one of these. Match a new one to a case or
don't write it.

1. **Icon-only control** — the only content is a glyph, or a glyph plus a bare count.

   ```tsx
   // apps/web/src/components/pano/CommentTreeNode.tsx — the collapser's "[ + ]" names nothing
   <Button variant="link" size="sm" aria-label={open ? "Daralt" : "Genişlet"}
   	onClick={() => setOpen(!open)}>
   	[ {open ? "—" : "+"} ]
   </Button>
   ```

   Note this lives at the **call site**, not in `packages/design/src/Collapsible.tsx` — that wrapper is a bare
   re-export and injects nothing.

2. **Form input with no visible `<label>`** — a placeholder is not a name. The topbar search
   `<Input name="q" placeholder="ara…" aria-label="Ara">`, the sözlük edit `Textarea`.

3. **Landmark or group disambiguation** — two same-role landmarks (`<section>`, `<nav>`) need
   distinct names so a screen reader's landmark list is navigable; a grouping element around an
   unnamed control set needs one for the same reason. The four `DivanPage` panes, the sözlük
   alphabet `<nav aria-label="Harf">`, `PropKnobs`' `<fieldset>` around each `ToggleGroup`.

4. **Status / live region** — a `role="status"` region whose content is dynamic or glyph-only. The
   unread-bildirim announcement, a `yükleniyor…` skeleton.

## Prefer `aria-labelledby`→a heading over a duplicated string

When a region has a visible heading, point at it rather than retyping the text — one source of
truth, and the name can't drift from the heading. The house shape:

```tsx
// apps/web/src/components/authorship/FirstContributionOnramp.tsx
<section aria-labelledby={headingId}>
	<h2 id={headingId}>{/* the visible heading text IS the region's name */}</h2>
</section>
```

## Anti-patterns

- **A redundant `aria-label` on a control that already has a name.** It replaces the on-screen text
  as the accessible name, so a sighted user and a screen-reader user get *different* words, and
  they drift independently. Delete it.
- **An `aria-label` on a `Dialog` or `Popover` instead of a `title`.** Manti gives you no prop for
  it, and reaching past the component to set one would suppress the title link — the dialog ends up
  named by a string with no on-screen counterpart.
- **A `Dialog` with no `title`.** The `aria-labelledby` probe finds nothing and the dialog is
  unnamed. Every Manti dialog takes a `title`; pass it.
- **"Fixing" a11y voice by lowercasing every `aria-label`.** That treats the symptom, not a
  hand-authored label diverging from the visible text. Casing is irrelevant.
- **A `role`/`aria-expanded`/`aria-controls`/`aria-haspopup` written by hand.** The machine already
  emitted it. On `Menu`'s content and `ToggleGroup`'s items Manti merges the machine's props *last*,
  so a hand-written one is silently discarded rather than winning — check the merge order in
  `dist/index.js` before assuming an escape hatch exists.

## See also

- `packages/design/src/` — the wrapper layer. Most are bare re-exports; a wrapper earns code
  only when it corrects the primitive (`Switch.tsx` re-asserts Zag's uncontrolled hidden input).
- [property-based-a11y.md](./property-based-a11y.md) — the `fast-check` × `axe-core` gate over
  `@kampus/design`. Note the compound primitives above are all parked `deferred` there, so nothing
  automatically catches a naming regression in them.
- [zag-machine-interaction-tests.md](./zag-machine-interaction-tests.md) — why a test that clicks a
  Manti primitive must flush a microtask before asserting.
- [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) — biome's built-in `lint/a11y`
  rules run in CI; `apps/web/src` currently carries no `biome-ignore lint/a11y/*`.
