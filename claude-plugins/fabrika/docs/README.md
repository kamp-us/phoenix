# fabrika docs

The canonical convention and contract docs for fabrika. One doc per source of truth: an authoring
session, a reviewer, or a verb implementer reads the doc, never a transcript and never another
skill's prose.

Everything here is **reference** — the rules an artifact is held to. The *why* behind a rule lives
in the host repository's own decision records, and a doc that would re-derive that reasoning points
at the record instead.

The human-facing pages live in [`../guide/`](../guide/README.md).

| Doc | What it fixes |
|---|---|
| [skill conventions](skill-conventions.md) | the writing discipline every fabrika skill meets — the two-layer split, wrapper sizing, invocation-axis economics, the plain-literal invocation surface, the quality vocabulary and failure-mode taxonomy, checkable completion criteria, the scope law, the ship gate, trust and ingestion, the leaf rule, REST-never-GraphQL GitHub access, number-declaring skills, and fork-versus-inline execution |
| [CLI interface convention](interface-convention.md) | the discipline every fabrika verb owes its caller — `--help` discoverability, stdout/stderr channels, exit codes, fail-closed scope, plain-literal invocations, delivery, no calls outside fabrika |
| [contract-spec format](contract-spec-format.md) | what an authoring session emits per skill — required sections, the completeness test, a worked example |
| [cli-interface-convention](cli-interface-convention.md) | the split record — where each half of the former combined doc moved; kept standing because older prose still cites it by name |
| [authoring-brief contract](authoring-brief-contract.md) | the boot document a stateless authoring session works from — required fields, the brief-is-not-write-code fence, who writes it, its completeness test, a worked example |
| [wire formats](wire-formats.md) | the index of the byte-level agreements two skills meet through — format → owner module → producers/consumers, the staging rule a new format lands under, how to add one, none of the shape |
| [§CP classification](control-plane-classification.md) | the ruled control-plane model every §CP-computing verb implements and every §CP-mentioning skill is held to — CODEOWNERS as single source, teams and individual `@login`s alike, three-valued, an absent boundary is the `unknown` hold and an unreadable one is the caller's `11`, no semantic detection |
| [agent shells](agent-shells.md) | what an agent shell in [`../agents/`](../agents/) is, its three-field shape, the noun-naming rule and bare-noun address, the no-`memory:` and no-`effort:` rules, the model rule, the spawn-tool baseline, and the fields a plugin-scope shell may not use |
| [hook surface](hook-surface.md) | where a fabrika hook is declared ([`../hooks.json`](../hooks.json)) and how it invokes a verb, the harness exit-code contract, the ruled dispatch-failure policy point, the record format a grading pass writes its verdicts into |
