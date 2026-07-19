# design-inventory

The self-updating extractor for the **descriptive component inventory** — issue
[#3155](https://github.com/kamp-us/phoenix/issues/3155), epic
[#3150](https://github.com/kamp-us/phoenix/issues/3150), ADR
[0194](../../../../../.decisions/0194-design-law-jsdoc-firewall.md).

## What it does

It reads the JSDoc-on-code metadata off the shipped `apps/web/src/components/ui`
primitives and emits one central curated-hybrid index — inline each primitive's
when-to-use, link to source for depth (the effect-smol `LLMS.md` idiom). The index is the
_descriptive_ half of the design docs: which primitives exist, their slots, and each one's
when-to-use. It keeps agent-facing component coverage current without founder
re-transcription.

The metadata schema (ADR 0194) is a lean JSDoc tag vocabulary on each primitive:

- `@component <Name>` — opens one primitive's block (a file may declare several).
- `@whenToUse <text>` — the selection guidance, which _references_ the manifest's law.
- `@slot <name> <description>` — a named content slot (repeatable).
- `@agent <text>` — protected human-seeded steering the extractor preserves (repeatable).

## The descriptive/normative firewall

The tool writes **only** the descriptive inventory artifact
(`design-system-inventory.md`). The _normative_ design law — the four pillars, the
prohibitions, and the role-token values in `design-system-manifest.md` — is
founder-authored (ADR [0078](../../../../../.decisions/0078-product-driven-decisions-by-default.md))
and is unreachable from this tool. That boundary is enforced in code (`gate.ts`'s
`writeDescriptiveArtifact` refuses any target but the inventory), not merely intended — a
write at the manifest path is a `FirewallViolation`, proven by test.

## Usage

```bash
pipeline-cli design-inventory generate            # write design-system-inventory.md from the primitives' JSDoc
pipeline-cli design-inventory generate --stdout   # print the index instead of writing it
pipeline-cli design-inventory generate --check    # red on drift (freshness signal; CI wiring is #3156)
pipeline-cli design-inventory generate --root <d> # point at a specific repo root (else: walk up for one)
```

Fail-closed on zero scope (ADR
[0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)): zero annotated
primitives discovered is a broken scope assumption, not a vacuous empty index.

## Shape

The `pipeline-cli` guard idiom — a pure IO-free core, a thin filesystem gate, a thin CLI:

- `design-inventory.ts` — pure core: parse the `@component` JSDoc schema, build the sorted
  inventory (fail-closed on zero), render the index, and the firewall predicate.
- `gate.ts` — the filesystem seam: read the primitives, write the artifact through the
  firewall, or `--check` for drift.
- `command.ts` — wires the gate to `pipeline-cli design-inventory generate`.
- `*.unit.test.ts` — pure-core and gate-seam tests (T0/T1, ADR
  [0040](../../../../../.decisions/0040-testing-taxonomy-and-seam-graduation.md)).

## Out of scope

The CI wiring that runs `--check` on every diff and enforces the firewall as a merge gate
is the next child ([#3156](https://github.com/kamp-us/phoenix/issues/3156)); on-demand
per-component contract delivery is the deferred child
([#3158](https://github.com/kamp-us/phoenix/issues/3158)).
