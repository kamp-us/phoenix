# Brand-imagery grammar — "ASCII cutaway kampüs"

The **CLAUDE.md for brand art**: the agent-readable transcription of the founder-ratified
brand-**imagery** language for kamp.us — the visual grammar any human or agent reads *before*
generating marketing / product / launch imagery (landing hero, launch art, empty states), the
sibling of [design-system-manifest.md](./design-system-manifest.md) for the marketing surface.

The normative content is **founder-authored, not agent-invented**. It transcribes a settled
visual language the founder explicitly ratified in a Midjourney exploration session, mirroring the
[design-system-manifest](./design-system-manifest.md)'s founder-authored / agent-transcribed
pattern and the precedent of ADR
[0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md)
(founder-ratified design *law*, transcribed into a living doc, not agent-invented). An agent
**transcribes** this grammar; it does **not** author brand voice. Where the grammar is silent, the
gap is surfaced to the founder — it is never filled here.

> **Capture, not ratification.** This doc is the durable-home *capture* of already-settled
> direction. The final wording gets a **founder + cansirin ratify pass** before it is treated as
> canonical — the same checkpoint the design manifest carries. Transcription is faithful to the
> founder's phrasing on purpose (the brand voice is the point); anywhere a wording choice was made
> is flagged in the PR for that ratify pass to focus on.

The ethos this imagery encodes lives in [README.md](./README.md) ("yavaş bir köşe", the
çaylak → yazar rite, kapı açık). The brand nouns it references — **kampüs**, **pano**, **sözlük**,
**divan** — are defined in [.glossary/LANGUAGE.md](./.glossary/LANGUAGE.md), the canonical
vocabulary register; this doc uses them, it does not redefine them.

---

## Style — "ASCII cutaway kampüs"

Campus scenes rendered as **monospace-character / terminal art**: a phosphor-CRT texture with
subtle **scanlines**, drawn as an **underground cross-section**. The frame is muted campus above
ground and dark earth below, and the tree's **root system glows coral as the brightest element** of
every frame. The cut-away — surface above, roots below — is the signature; the glowing root system
is always the light source.

## Subject hierarchy

Every frame reads in this order, and only this order:

1. **kampüs first** — the courtyard, the amphitheater steps, buildings with lit windows. The place
   comes first.
2. **Glowing roots** — the community's future, "we grow roots". The roots below ground are the
   brightest thing in the frame; they *are* the emotional subject.
3. **Phoenix — small, elegant, always in the moment of *landing*.** The phoenix is the new-era
   arrival, caught descending to land. It is **never dominating, never "rising"** — small and
   elegant, a note in the corner, not the hero.

## Palette — mapped to the shared design tokens

Coral/tomato accent on deep dark mauve-charcoal — the product's **own** `--tomato-9` on
`--mauve-1/2` relationship, so brand art and UI share **one** color system. The values below are
grounded against the live token layer,
[`apps/web/src/styles/tokens.css`](apps/web/src/styles/tokens.css) (the raw-scale block), so a
prompt cites the *real* token hex, not a remembered one.

| Brand role | Token | Live hex (source of truth) | Notes |
|---|---|---|---|
| Coral glow (roots, phoenix ember, accents) | `--tomato-9` | `#e54d2e` | Matches the issue's `#e54d2e` exactly. The single brightest hue in every frame. |
| Deep charcoal ground (the darkest base) | `--mauve-1` | `#121113` (dark theme) | Matches the issue's `#121113`. The near-black terminal ground. |
| Raised charcoal (surface a step up) | `--mauve-2` | `#1a191b` (dark theme) | The issue lumped the base as `--mauve-1/2 = #121113`; the *live* `--mauve-2` is `#1a191b` (a hair lighter than `--mauve-1`). Use `#121113` for the darkest ground and `#1a191b` for a raised charcoal step. |

Brand art lives in the **dark** register (the phosphor-CRT terminal), so the dark-theme values are
canonical here; `--tomato-9` is `#e54d2e` in both themes. Both live under the role-token system the
UI consumes — coral is `--accent-9` / `--accent`, charcoal is `--gray-1` / `--surface-sunken` — so
brand art and interface are one system, never two.

## Turkish identity carriers

The details that make a frame unmistakably kamp.us — the "anlayana" layer:

- **erguvan** / Judas-tree blossoms (or **çınar** / **hayat ağacı** variants).
- **tulip çay glasses** (ince belli).
- **campus cats**.
- **"anlayana" details** — e.g. roots drawn as node-graphs / circuit traces; an optional single
  **blue nazar bead** breaking the palette (the one sanctioned break from coral-on-charcoal).

## Crowd rule

People phrases must be **explicitly mixed**: "women and men…, **roughly half women**". A bare
"developers" renders **all-male** in image models — never use it. Always name the mix.

## Working prompt formula — Midjourney v8.1

Transcribed verbatim from the founder's settled formula:

```
detailed ASCII art on a dark terminal screen: …campus scene…, root system below ground as
dense glowing character clusters, a small elegant phoenix descending to land…, coral-red
(#e54d2e) accents, deep dark charcoal (#121113), subtle scanlines --ar 16:9 --style raw
--stylize 100
```

The `#e54d2e` / `#121113` literals in the formula are the `--tomato-9` / `--mauve-1` token values
above — keep them in sync with `tokens.css` if the tokens ever move.

## Do-nots

The founder explicitly rejected these — a generated frame that does any of them is off-brand:

- **No giant tree.** The tree is the cut-away frame, not a towering hero.
- **No dominant or "rising" phoenix.** The phoenix is small, elegant, and *landing* — never large,
  never ascending, never the drama of the frame.
- **No all-male crowds.** Apply the crowd rule — roughly half women, explicitly mixed; never bare
  "developers".

---

## Out of scope — deferred follow-ups

Captured here for the record; **not** built in this doc:

- **The hand-authored ASCII startup banner** for the CLI / dev server (the "functional twin" of the
  brand art) — a separable code deliverable (an observable behavior change), a follow-up to file
  and build separately, not part of this doc-home capture.
- **The scene-variant expansion set** already sketched in the exploration — shared-root-network
  (diaspora), rite-in-three-trees (çaylak → yazar), pano notice board, sözlük shelf, campus gate,
  under-the-hood (roots → server racks), and ASCII spot illustrations for empty / 404 / loading
  states. These extend the grammar above; they are a separate expansion, not transcribed here.
