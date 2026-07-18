# Component-metadata JSDoc convention

The per-component metadata convention on the `apps/web/src/components/ui/` primitives:
a **deliberately-minimal v1** JSDoc schema, colocated with the code, that carries only the
**descriptive** half of the design docs — which primitives exist, their props/slots, and a
per-component when-to-use. It is the source corpus a doc extractor reads to build the central
component index. Ratified in ADR
[0194](../.decisions/0194-design-law-jsdoc-firewall.md); seeded on the a11y-registry primitives
in [#3153](https://github.com/kamp-us/phoenix/issues/3153), rolled across the rest in
[#3154](https://github.com/kamp-us/phoenix/issues/3154).

## The firewall (read this first)

The schema carries **descriptive** content only. The **normative** design law — the four
pillars, the prohibitions, and the role-token values — is founder-authored and lives in
[`design-system-manifest.md`](../design-system-manifest.md); it is **never** authored onto a
primitive (ADR 0194). A component's `@whenToUse` may *reference* that law ("see
`design-system-manifest.md`") but must never mint a new rule — it is a descriptive echo that
points at the normative, not a second copy of it. Authoring a prohibition or a new selection
rule onto a primitive is a firewall violation.

## The v1 tag set

Author these as a JSDoc block on the component's declaration (the exported function /
`forwardRef` / compound-object `const`; for a compound like `Menu`/`Dialog`, on the object
export). Keep the vocabulary lean — the schema is expected to grow by iteration as real use
surfaces gaps (ADR 0194 §2), not by up-front over-specification.

| Tag | Meaning |
|---|---|
| `@component <ExportName>` | Marks this declaration as a catalogued design-system primitive; the value is the export name the extractor keys on. |
| `@whenToUse <prose>` | The per-component when-to-use — when to reach for this primitive vs. an alternative. Descriptive; references manifest law by pointer, never restates or mints it. |
| `@slot <name> <desc>` | A composition slot the component exposes: `children`, a named render prop (`icon`), or a compound sub-part (`Menu.Item`, `Dialog.Head`). One `@slot` per part. |
| `@agent <directive>` | Protected steering the extractor must **preserve verbatim** (never regenerate). Use sparingly, only where genuine steering exists; it echoes manifest guidance, it does not author law. |
| prop-level JSDoc | A `/** … */` on each documented prop declaration — the existing `Button.tsx` idiom. Describes the prop; no `@`-tag needed. |

## Worked shape

```tsx
/**
 * @component Card
 * @whenToUse The opinionated default for a NEW surface — a bordered, subtly-raised,
 *   padded box. Reach for `Surface` with explicit props only to preserve an existing
 *   shell's exact look during a migration (the composite-primitive selection rule is
 *   the manifest's, referenced not restated — see `design-system-manifest.md`).
 * @slot children The card's content.
 * @agent Prefer this composite over hand-rolling a bordered box; do not regenerate
 *   this selection guidance — it echoes the manifest's component-selection rule.
 */
export function Card(/* … */) { /* … */ }

export interface CardProps extends SurfaceProps {
	/** Add the hover affordance (background + border shift) for a clickable card. */
	interactive?: boolean;
}
```

## Extractability

The block is machine-extractable via the TypeScript compiler API (`ts.getJSDocTags` for the
`@component`/`@whenToUse`/`@slot`/`@agent` tags; `ts.getJSDocCommentsAndTags` on each
`PropertySignature` for prop docs) — no react-docgen dependency required. The doc extractor
(a separate deliverable) reads exactly this path; keep the tags well-formed so it stays a live
corpus.

## Adding metadata to a primitive

1. Put the block on the export declaration (or the compound object export).
2. Author `@component`, `@whenToUse`, and one `@slot` per composition point.
3. Add prop-level JSDoc to each documented prop (reuse the existing block if the file already
   carries a rich docblock — append the tags rather than opening a second, near-duplicate one).
4. Keep it descriptive: no prohibitions, no new selection rules, no role-token values. Reference
   `design-system-manifest.md` for the law.
