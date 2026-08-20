# fabrika docs

The canonical convention and contract docs for fabrika. One doc per source of truth: an authoring
session, a reviewer, or a verb implementer reads the doc, never a transcript and never another
skill's prose.

Everything here is **reference** — the rules an artifact is held to. The *why* behind a rule still
lives in [`.decisions/`](../../../.decisions/), and a doc that re-derives an ADR's reasoning should
point at it instead.

The human-facing pages live in [`../guide/`](../guide/README.md).

This directory is the home; the docs themselves land as the foundation epic's later children
([#4648](https://github.com/kamp-us/phoenix/issues/4648)):

| Doc | What it fixes | Child |
|---|---|---|
| [skill conventions](skill-conventions.md) | the writing discipline every fabrika skill meets — the two-layer split, wrapper sizing, invocation-axis economics, the quality vocabulary and failure-mode taxonomy, checkable completion criteria, the scope law, the literal-invocation rule, the ship gate, trust and ingestion, the leaf rule, and the REST-never-GraphQL GitHub-access rule | #4653 |
| [CLI interface convention + contract-spec format](cli-interface-convention.md) | what every fabrika verb owes its caller (`--help` discoverability, uniform output contracts, usage examples) and the shape of the contract a skill derives for the verbs it needs | #4654 |
| [authoring-brief contract](authoring-brief-contract.md) | the boot document a stateless authoring session works from | #4655 |
| [wire formats](wire-formats.md) | the index of the byte-level agreements two skills meet through — format → owner module → producers/consumers, with the protocol narrative and none of the shape | #4945 |
| [§CP classification](control-plane-classification.md) | the ruled control-plane model every §CP-computing verb implements and every §CP-mentioning skill is held to — CODEOWNERS as single source, teams and individual `@login`s alike, three-valued, an absent boundary is the `unknown` hold and an unreadable one is the caller's `11`, no semantic detection | #4932 |
| [agent shells](agent-shells.md) | what an agent shell in [`../agents/`](../agents/) is, why there are exactly three, why its name is a noun, the no-`memory:` ruling, the model allowlist, and the rule that a shell which grows opinions is a defect | #5586, #5617 |
| [hook surface](hook-surface.md) | where a fabrika hook is declared ([`../hooks.json`](../hooks.json)) and how it invokes a verb, the one interim dispatch-failure policy point, and the grading records — one recorded verdict per graded v1 piece | #5074, #5076 |
