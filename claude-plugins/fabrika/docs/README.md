# fabrika docs

The canonical convention and contract docs for fabrika. One doc per source of truth: an authoring
session, a reviewer, or a verb implementer reads the doc, never a transcript and never another
skill's prose.

Everything here is **reference** — the rules an artifact is held to. The *why* behind a rule still
lives in [`.decisions/`](../../../.decisions/), and a doc that re-derives an ADR's reasoning should
point at it instead.

This directory is the home; the docs themselves land as the foundation epic's later children
([#4648](https://github.com/kamp-us/phoenix/issues/4648)):

| Doc | What it fixes | Child |
|---|---|---|
| [skill conventions](skill-conventions.md) | the writing discipline every fabrika skill meets — the two-layer split, wrapper sizing, invocation-axis economics, the quality vocabulary and failure-mode taxonomy, checkable completion criteria, the scope law, the literal-invocation rule, the ship gate | #4653 |
| CLI interface convention + contract-spec format | what every fabrika verb owes its caller (`--help` discoverability, uniform output contracts, usage examples) and the shape of the contract a skill derives for the verbs it needs | #4654 |
| authoring-brief contract | the boot document a stateless `/skill-creator` session works from | #4655 |
