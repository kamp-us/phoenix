# @phoenix/epic-ledger

The deterministic structural **floor** for an epic's executable task ledger — the symmetric twin
of `review-code`, one stage earlier. Where `review-code` gates `write-code` → merge, this package
is the validator a `review-plan` gate runs to keep `plan-epic`'s output from reaching `write-code`
structurally broken.

It is **Effect v4-native**: the domain is `effect/Schema`, untrusted GitHub JSON is decoded at the
boundary, and the validation core is a pure, deterministic function over the decoded ledger.

```
untrusted gh api JSON                decode (boundary)            pure floor
─────────────────────                ─────────────────            ──────────
{ epic, children }       ──►   decodeEpicLedger  ──►  EpicLedger  ──►  validateLedger ─► Defect[]
(issue bodies + labels)        (Schema + markdown      (Schema)        isPickable     ─► boolean
                                parsing at decode)                     ledgerSignature ─► string
```

## The surface

- **Domain (`effect/Schema`)** — `EpicLedger` / `EpicHeader` / `ChildIssue` / `DependencyGraph`
  (`Schema.Struct`), `DefectType` (`Schema.Literals` over the closed 7-type enum), `Defect`
  (`Schema.Struct`).
- **`validateLedger(EpicLedger): readonly Defect[]`** — the canonical, deterministically-ordered
  hard-defect set over the closed enum: `MISSING_DEPS_SECTION`, `DEP_CYCLE`, `DANGLING_DEP`,
  `ORPHAN_CHILD`, `ZERO_AC`, `MISSING_LABEL`, `NEEDS_TRIAGE_LABEL`.
- **`isPickable(EpicLedger): boolean`** — the flip predicate: no hard defect.
- **`ledgerSignature(EpicLedger): string`** — a run-stable fingerprint of the defect set (type +
  refs, messages omitted) the re-plan loop compares across iterations to detect a stall.
- **`decodeEpicLedger(unknown): Effect<EpicLedger, SchemaError>`** — the GitHub trust boundary:
  decodes REST JSON and lowers the epic's `## Dependencies` topology + each child's
  acceptance-criteria checklist to the domain via the tolerant markdown parser.

## Determinism

The floor is deterministic by construction — same ledger, same defects, same signature, **whatever
order the inputs arrived in**. Every check derives from set membership and sorted issue numbers,
and the defect list is sorted by canonical defect-type rank then by ref. A permuted child array or
a re-ordered `## Dependencies` listing yields a byte-identical `validateLedger` result and an
identical `ledgerSignature`. The downstream re-plan loop's stall detection depends on this.

## Conventions

The formats this validator checks against — the `## Dependencies` grammar and the ≥1-acceptance-
criterion sub-issue invariant — live in
[`.claude/skills/gh-issue-intake-formats.md`](../../.claude/skills/gh-issue-intake-formats.md).
Effect idioms follow the repo's [`.patterns/effect-schema-validation.md`](../../.patterns/effect-schema-validation.md)
(Schema at the trust boundary) and [`.patterns/effect-testing.md`](../../.patterns/effect-testing.md)
(T0 `*.unit.test.ts`).

```bash
pnpm --filter @phoenix/epic-ledger typecheck
pnpm --filter @phoenix/epic-ledger test
```
