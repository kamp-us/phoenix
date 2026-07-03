# Base UI accessibility — what's automatic, and the four times you name a control by hand

phoenix's UI primitives are [Base UI](https://base-ui.com) (`@base-ui/react`), which is
**accessible by default**: it wires roles, the disclosure/popup ARIA relationships, and focus
management itself, and it derives a control's **accessible name from the control's own visible
content**. So a hand-authored `aria-label` is a **smell** — it means either you're duplicating a
name Base UI already computes (redundant, and it *overrides* the visible text, which is how the
label and the on-screen text drift apart), or the control genuinely has no visible text and you're
in one of the **four** legitimate cases below. Reach for `aria-label` only after you've checked
which. There is no lowercase/casing rule and no lint guard for this — the rule is *don't add the
attribute unless the control earns it.*

Ground truth is the Base UI source and the phoenix wrappers in `apps/web/src/components/ui/`; when
this doc and the source disagree, fix the doc.

## What Base UI wires for you (don't re-supply it)

Base UI splits ARIA into two mechanisms, both automatic:

| Primitive | Automatic | Where the accessible **name** comes from |
|---|---|---|
| `Dialog` / `AlertDialog` | popup `role`, focus trap + restore (`FloatingFocusManager`), and `aria-labelledby`/`aria-describedby` **synced from `Dialog.Title`/`Dialog.Description`** | the `Dialog.Title` element — supply a Title, not an `aria-label` |
| `Popover` | same title/description id-sync as Dialog | the `Popover.Title` element |
| any trigger (`Dialog`/`Menu`/`Popover`/`Select`) | `aria-haspopup`, `aria-expanded`, `aria-controls`, popup `role`, `<button>` semantics + keyboard — via the vendored floating-ui `useRole` | the trigger's text content |
| `Menu.Item` | `role`, composite focus/typeahead | the item's **text content** (the `label` prop is typeahead-match only, **not** the name) |
| `Collapsible.Trigger` | `aria-expanded`, `aria-controls` | the trigger's text content — relationship is wired, **name is not** |
| `Tooltip` | `aria-describedby` on the trigger (a tooltip is a *description*, not a name) | n/a — a tooltip never provides a name |

The two mechanisms in source: title/description labelling is a store id-sync — `Dialog.Title`
publishes its generated id (`store.useSyncedValueWithCleanup('titleElementId', id)`) and
`Dialog.Popup` reads it back as `'aria-labelledby': titleElementId ?? undefined`; the
trigger/popup relationship props come from floating-ui's `useRole` hook merged into the trigger.
You never write any of this by hand.

```tsx
// src/components/ui/Dialog.tsx — Head renders Base UI's Title, so the popup is auto-labelled
export const Dialog = {
	// ...
	Head: ({title, description}) => (
		<>
			<BaseDialog.Title render={<h2 />}>{title}</BaseDialog.Title>
			{description ? <BaseDialog.Description>{description}</BaseDialog.Description> : null}
		</>
	),
};
// A Dialog that uses <Dialog.Head> needs NO aria-label on the popup — the Title IS the name.
```

## The one gap: Base UI never invents a name for icon-only content

Base UI wires *relationships and roles*, but the accessible **name is always the element's own
text** (or an explicit `aria-label` / `Dialog.Title`). So when a control's only child is a glyph —
`×`, `⋯`, `+`/`–`, a `▲` vote arrow, a color swatch — there is no text to name it, and you must
supply one. That is the whole of when a hand-authored label is correct.

## The decision

```
Does the interactive control have a visible text child?
├─ yes → NO aria-label. Base UI (or the DOM) already names it from that text.
│        Adding one is redundant and overrides the visible text — delete it.
└─ no  → it needs a name. In priority order:
         1. Dialog/Popover with no Title  → add a <Dialog.Title> (best — a visible heading)
         2. a control near a visible heading → aria-labelledby={headingId} (point at the text)
         3. genuinely icon-only            → aria-label="<turkish label>"
```

Casing on a hand-authored label doesn't matter (`"Kapat"` is fine) — the label is the accessible
name, read by a screen reader, not shown on screen. What matters is that it *exists* only where
there's no visible text to derive it from.

## The four legitimate hand-authored-label cases

Every `aria-label`/`aria-labelledby` in `apps/web/src` is one of these — none is a redundant label
on a text-bearing control. Match a new one to a case or don't write it.

1. **Icon-only control** — the only child is a glyph. The close `×`, a `⋯` menu trigger, the
   `+`/`–` collapser, `▲`/`△` vote buttons.

   ```tsx
   // src/components/ui/Collapsible.tsx — Base UI gives aria-expanded/controls; the NAME is ours
   export const Collapsible = {
   	Trigger: ({open, children}) => (
   		<BaseCollapsible.Trigger aria-label={open ? "Daralt" : "Genişlet"}>
   			{children /* the +/– glyph */}
   		</BaseCollapsible.Trigger>
   	),
   };
   ```

2. **Form input with no visible `<label>`** — a placeholder is not an accessible name. The topbar
   search `<input name="q" aria-label="Ara">`, the sözlük term-search input.

3. **Landmark / group disambiguation** — two same-role landmarks (`<section>`, `<nav>`, a
   role-bearing `<ul>`) need distinct names so a screen-reader's landmark list is navigable. The
   four `DivanPage` panes, the sözlük alphabet `<nav aria-label="Harf">`.

4. **Status / live region** — a `role="status"` region whose content is dynamic or glyph-only
   (the unread-notifications badge, a `yükleniyor…` skeleton).

## Prefer `aria-labelledby`→a heading over a duplicated string

When a region has a visible heading, point at it rather than retyping the text in an `aria-label` —
one source of truth, and the name can't drift from the heading. This is the house-preferred shape:

```tsx
// src/components/authorship/FirstContributionOnramp.tsx
<section aria-labelledby={headingId}>
	<h2 id={headingId}>{/* the visible heading text IS the region's name */}</h2>
	{/* ... */}
</section>
```

## Anti-patterns

- **A redundant `aria-label` on a control that has visible text.** It overrides the on-screen
  text as the accessible name, so a sighted user and a screen-reader user get *different* words,
  and they drift independently over time. Delete it; let the visible text be the name.
- **"Fixing" the a11y voice by lowercasing every `aria-label`.** That treats the symptom
  (Title-Case labels) not the disease (a hand-authored label diverging from the visible text). The
  fix is to not author the label at all where visible text exists — casing is irrelevant.
- **A `Dialog` with no `Dialog.Title`.** Its `aria-labelledby` resolves to `undefined` and the
  dialog is unnamed. Add a `<Dialog.Title>` (via `<Dialog.Head>`); fall back to `aria-label` only
  if there is deliberately no visible heading.
- **Re-implementing a primitive to avoid Base UI's a11y.** `apps/web/src/components/ui/Toast.tsx`
  is hand-rolled instead of using `@base-ui/react/toast`; that's why it carries manual
  `role="status"` + `aria-label` wiring Base UI would have supplied. Prefer the Base UI primitive;
  a hand-roll owns its own a11y and is the thing most likely to get it wrong.

## Rules

- Don't add an `aria-label` to a control that has a visible text child — Base UI/the DOM already
  names it from that text.
- Name an icon-only control (no visible text): `Dialog.Title` → `aria-labelledby`→heading →
  `aria-label`, in that order of preference.
- Let Base UI wire `role`/`aria-expanded`/`aria-controls`/`aria-haspopup`/focus — never hand-write
  the disclosure/popup relationship props.
- A hand-authored label's casing is free; its *existence* must be justified by one of the four
  cases above. If it isn't, you're overriding a name Base UI already computes.

## See also

- `apps/web/src/components/ui/` — the Base UI wrapper layer (`Dialog`, `Menu`, `Collapsible`,
  `Tooltip`, `ToggleGroup`); the wrappers that inject an icon-only name do so once, on every
  consumer's behalf (e.g. `Collapsible.tsx`).
- [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) — biome's built-in `lint/a11y`
  rules already run in CI; a `// biome-ignore lint/a11y/...` (e.g. the `useHeadingContent` ignore
  in `Dialog.tsx`, whose text arrives via `children`) is the sanctioned escape when the linter
  can't see through a render prop.
