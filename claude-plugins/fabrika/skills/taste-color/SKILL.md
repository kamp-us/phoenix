---
name: taste-color
description: "Pick the colour a surface, border, text run, accent or focus ring is painted with, using the repo's own role-token layer. Trigger before writing or editing any styled UI — a new component, a theme pass, a state or status treatment, a contrast or dark-mode fix — and whenever a review needs the vocabulary to say why a colour choice is wrong."
---

# taste-color

You choose colour by **role**, not by value. The repo's design manifest already names one token
per colouring job; your whole job is picking the right row and refusing to paint anything the law
does not name. **The failure this skill exists to stop is the invented value** — a raw hex, a
scale token, or a status colour nobody ratified, which is the single defect class every real
design FAIL on record shipped.

This skill is **read-only**: it reads the repo's design manifest, its component inventory, and its
blessed goldens as law — repo files, never externally-authorable text — and it emits guidance. It
writes no file, runs no verb, and posts no verdict.

## Grounding and the firewall — advise, never author

Every rule below cites the named manifest or inventory section it comes from. **A colour rule
with no citation is not a rule** — it is an invention, and this skill does not carry one.

**Skills advise creation; only the founder authors design law.** So this skill never edits
`design-system-manifest.md`, never adds a token, and never promotes a preference into a
prohibition. It restates law and points at it; the law's own file is the source.

## The role table — one row per colouring job

Read the job in the left column, reach for the token in the middle, and check the cited manifest
section when you need the *why*. **Never** reach past this table into a raw scale (`--mauve-*`,
`--tomato-*`) or a semantic scale (`--gray-N`, `--accent-N`) — those are the layers the role
tokens exist to hide (Pillar 2, last prohibition).

| The job | Role token | Manifest anchor |
|---|---|---|
| Default page or card background | `--surface` | `### Surface roles` |
| A recessed well (inset panel, code block) | `--surface-sunken` | `### Surface roles` |
| A surface lifted above the page (raised card, popover body) | `--surface-raised` | `### Surface roles` |
| The lightest hairline separator | `--border-faint` | `### Border roles` |
| The default control or card border | `--border` | `### Border roles` |
| An emphasised divider or focused-field border | `--border-strong` | `### Border roles` |
| Primary body copy and headings | `--text-primary` | `### Text roles` |
| Secondary body text | `--text-secondary` | `### Text roles` |
| Meaning-carrying text at its lowest legal rung | `--text-muted` | `### Text roles` |
| Placeholder, disabled, or hint text — decorative only | `--text-faint` | `### Text roles` |
| A solid accent fill | `--accent` | `### Accent / link roles` |
| Text or an icon sitting on a solid `--accent` fill | `--accent-fg` | `### Accent / link roles` |
| A hover wash or subtle highlight | `--accent-soft` | `### Accent / link roles` |
| The faintest accent tint | `--accent-faint` | `### Accent / link roles` |
| Link text | `--link` | `### Accent / link roles` |
| Any interactive control's focus ring | `--focus-ring` + `--focus-ring-offset` | `### Focus role` |

No row fits? That is the silence case below — not a licence to pick.

## The rules

**Paint every component colour from a role token.** The role layer is the only layer a component
may reference (`## Semantic token annotations — reach for the role layer only`; Pillar 2, last
prohibition). A component reaching a scale directly re-themes wrong the day the scale moves.
*Counterexample: `color: var(--gray-11)` on a byline where `--text-muted` is the role.*

**Never write a literal colour into a component** — no hex, `rgb()`, `hsl()`, or hand-rolled
colour function. Only the token layer holds literals (`## Semantic token annotations`), so a
literal in a component is a value outside the system with nothing to keep it in step.
*Counterexample: `background: #1a1a1a` on a card instead of `--surface`.*

**Keep meaning-carrying text at `--text-muted` or above.** `--text-faint` clears 3:1 and is
decorative only; the meaning floor is AA 4.5:1 (`### Text roles`; v1 design value 7 — Contrast
floors; Pillar 4, first prohibition). Below the floor the text is invisible to the readers who
need it most. *Counterexample: a post timestamp on `--text-faint`.*

**Hold non-text UI at 3:1** — borders, icons, and control affordances (v1 design value 7 —
Contrast floors). A border under 3:1 is decoration, so anything it was meant to delimit reads as
undelimited. *Counterexample: `--border-faint` as the only edge of an input field.*

**Carry every state in text, an icon, or shape as well as colour.** Colour alone never signals
state or meaning (Pillar 4, last prohibition; the inventory's `Badge` when-to-use says the same:
keep state in text, not colour alone). Colour-blind and greyscale readers lose the signal
entirely. *Counterexample: an invalid input marked only by a red border.*

**Leave the focus ring to the shared layer.** `--focus-ring` and `--focus-ring-offset` are painted
once by the single `:focus-visible` rule (`### Focus role`; Pillar 4, second prohibition), so a
per-component outline is a second focus system that drifts from the first.
*Counterexample: `outline: 2px solid var(--accent-9)` on a custom button.*

**Drive every icon from `currentColor`.** Icon colour is never hardcoded — icons inherit from the
role token on their text context, the active vote glyph's `--accent` fill being the one sanctioned
exception (Pillar 2, icon-colour prohibition). A hardcoded icon stops tracking the text it sits
beside. *Counterexample: `stroke="#8b8b8b"` on a nav glyph.*

**Signal elevation with the four named shadow levels.** `--shadow-flat` / `--shadow-raised` /
`--shadow-dropdown` / `--shadow-overlay`, whose dark-mode definitions already lighten the surface
per level (v1 design value 5 — Elevation). Depth faked by darkening a background invents a fifth
level and breaks the ramp. *Counterexample: a custom `color-mix()` background to make a card look
raised.*

**Reach for the primitive that already owns the colour.** `Alert`, `Badge`, `Button`, `Card`, and
`Surface` carry their own role-token treatment (the component inventory's when-to-use entries;
Pillar 2, first prohibition). Re-colouring a hand-built equivalent is how a second palette starts.
*Counterexample: a hand-rolled bordered box tinted by hand where `Card` was the primitive.*

## Where the law is silent, surface the gap — never fill it

The manifest names **no** semantic status palette: there is no `--success`, `--warning`, or
`--danger` role token, and its closing section (`## Where the ADR is silent, surface the gap — do
not fill it`) says a gap is founder-ratified, never agent-filled. So when a status colour is
wanted:

1. Use the primitive that already encodes the status — `Alert`'s semantic variants, `Badge`'s
   status chip. **Verdict: proceed.**
2. No primitive covers it? Ship the state in text or an icon at a role token from the table above,
   which the colour-alone prohibition requires anyway. **Verdict: proceed, colour unresolved.**
3. Still blocked on a colour the law does not name? **Verdict: stop.** File the gap through
   `/report` and say in the PR body that the surface waits on ratified law. Never mint the token,
   never approximate it from a scale, never carry it as a local constant.

The same three steps apply to any colouring job with no row in the table.

## Required repo files

| Must exist | Why this skill needs it | When missing |
| --- | --- | --- |
| `design-system-manifest.md` at the repo root | Every role token, contrast floor, and prohibition cited above is read from it — this skill carries no colour law of its own | **fail-loud** — name the missing file, tell the user to run `/fabrika` for the bootstrap, and choose no colour; an improvised palette is the failure this skill exists to prevent. |
| `design-system-inventory.md` at the repo root | Supplies which primitive already owns a colour treatment, so a hand-built equivalent is not re-coloured | **degrade** — the role table and rules still apply; say in the PR body that primitive selection went unchecked. |
| A blessed golden for the surface | The visual reference a colour change is cross-checked against | **degrade** — an unblessed surface is a fact, not an error; the manifest's rules are then the only anchor. |
