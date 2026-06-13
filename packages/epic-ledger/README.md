# @phoenix/epic-ledger

The deterministic structural **floor** for an epic's executable task ledger — the symmetric twin
of `review-code`, one stage earlier. Where `review-code` gates `write-code` → merge, this package
is the validator a `review-plan` gate runs to keep `plan-epic`'s output from reaching `write-code`
structurally broken.

It is **Effect v4-native**: the domain is `effect/Schema`, untrusted GitHub JSON is decoded at the
boundary, the validation core is a pure, deterministic function over the decoded ledger, and the
`Github` capability reads a ledger by shelling `gh api` REST (`effect/unstable/process`).

```
gh api REST (shell)        decode (boundary)            pure floor
───────────────────        ─────────────────            ──────────
Github.epicLedger    ──►   decodeEpicLedger  ──►  EpicLedger  ──►  validateLedger ─► Defect[]
(issue bodies + labels)    (Schema + markdown      (Schema)        isPickable     ─► boolean
                            parsing at decode)                     ledgerSignature ─► string
```

## The surface

- **Domain (`effect/Schema`)** — `EpicLedger` / `EpicHeader` / `ChildIssue` / `DependencyGraph`
  (`Schema.Struct`), `DefectType` (`Schema.Literals` over the closed defect enum), `Defect`
  (`Schema.Struct`). `EpicHeader.stories` is the epic's declared `### User stories`; each
  `ChildIssue.stories` is that child's `**Stories:**` refs (`undefined` = no line → `MISSING_STORY`;
  `[]` = the explicit pure-infra marker, covers nothing by design).
- **`validateLedger(EpicLedger): readonly Defect[]`** — the canonical, deterministically-ordered
  hard-defect set over the closed enum: `MISSING_DEPS_SECTION`, `DEP_CYCLE`, `DANGLING_DEP`,
  `ORPHAN_CHILD`, `UNCOVERED_STORY`, `ZERO_AC`, `MISSING_STORY`, `MISSING_LABEL`,
  `NEEDS_TRIAGE_LABEL`. The two story defects enforce the story-coverage invariant (ADR 0046/0047):
  every declared story is covered by ≥1 child (`UNCOVERED_STORY`), every linked child traces to ≥1
  story (`MISSING_STORY`).
- **`isPickable(EpicLedger): boolean`** — the flip predicate: no hard defect.
- **`ledgerSignature(EpicLedger): string`** — a run-stable fingerprint of the defect set (type +
  refs, messages omitted) the re-plan loop compares across iterations to detect a stall.
- **`decodeEpicLedger(unknown): Effect<EpicLedger, SchemaError>`** — the GitHub trust boundary:
  decodes REST JSON and lowers the epic's `## Dependencies` topology + `### User stories` and each
  child's acceptance-criteria checklist + `**Stories:**` refs to the domain via the tolerant
  markdown parser.
- **`Github` / `GithubLive`** — the IO shell: a `Context.Service` on `ChildProcessSpawner` whose
  `epicLedger(epicNumber)` fetches the epic + its linked children over `gh api` REST (never GraphQL
  — broken on this org) and decodes an `EpicLedger`. Infra failures surface as typed
  `Schema.TaggedErrorClass` errors (`GhCommandError` for a non-zero `gh` exit, `GhParseError` for
  malformed JSON), never a throw. Provide the platform spawner (`NodeServices.layer`) to satisfy
  `GithubLive`'s `R`.

## Determinism

The floor is deterministic by construction — same ledger, same defects, same signature, **whatever
order the inputs arrived in**. Every check derives from set membership and sorted refs, and the
defect list is sorted by canonical defect-type rank then by ref. A permuted child array, a
re-ordered `## Dependencies` listing, or a re-ordered `### User stories` / `**Stories:**` set
yields a byte-identical `validateLedger` result and an identical `ledgerSignature`. The downstream
re-plan loop's stall detection depends on this.

## Conventions

The formats this validator checks against — the `## Dependencies` grammar, the ≥1-acceptance-
criterion sub-issue invariant, and the required `**Stories:**` field / story-coverage invariant —
live in
[`.claude/skills/gh-issue-intake-formats.md`](../../.claude/skills/gh-issue-intake-formats.md).
Effect idioms follow the repo's [`.patterns/effect-schema-validation.md`](../../.patterns/effect-schema-validation.md)
(Schema at the trust boundary), [`.patterns/effect-context-service.md`](../../.patterns/effect-context-service.md)
(the `Github` `Context.Service`), [`.patterns/effect-errors.md`](../../.patterns/effect-errors.md)
(typed errors), and [`.patterns/effect-testing.md`](../../.patterns/effect-testing.md)
(T0 `*.unit.test.ts`).

```bash
pnpm --filter @phoenix/epic-ledger typecheck
pnpm --filter @phoenix/epic-ledger test
```
