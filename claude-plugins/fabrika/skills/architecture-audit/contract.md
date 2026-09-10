# `/architecture-audit` — derived CLI contract

**Skill:** [`architecture-audit`](SKILL.md) · **Date:** 2026-09-10

## Verb inventory — none derived

**This skill derives no verb, and that is the finding of its split test rather than an omission.**
Every deterministic half of the audit was already shipped by a sibling group, so a new group here
would be a wrapper whose only behaviour is relaying an upstream answer — the shape the
[CLI interface convention](../../docs/cli-interface-convention.md) refuses. The verbs it calls, and
what each answers:

| Verb | What it answers here | Its own contract |
|---|---|---|
| `fabrika glossary check --register both` | whether the vocabulary registers exist and are well-shaped, before any walk | [`../glossary/contract.md`](../glossary/contract.md) |
| `fabrika status settings` | where the decision corpus lives (`decisionsDir`) and which repo catalogs extend the coverage gate (`auditCatalogs`) | the config key registry |
| `fabrika report dedup` | which open issues may already cover a finding | [`../report/contract.md`](../report/contract.md) |
| `fabrika report file` | the intake issue for a picked finding | [`../report/contract.md`](../report/contract.md) |
| `fabrika report note` | what a duplicated finding adds to the issue that already covers it | [`../report/contract.md`](../report/contract.md) |
| `fabrika wire doc-section` | one section of this file, by heading | [the wire group](../../docs/wire-formats.md) |

What is left over is judgment the wrapper keeps: what is friction, which lens findings are one
problem, how to rank them, and what to recommend. A verb that answered any of those would be a
stochastic answer wearing a deterministic exit code.

The one piece of **data** this skill adds to the CLI is the `auditCatalogs` config key —
`packages/fabrika-cli/src/config/keys/audit-catalogs.ts`, registered like every other key. It is a
key, not a verb: it declares paths and decides nothing.

## Considered and deliberately not derived

- **A `fabrika audit` verb group.** Proposed as the natural home for the lens passes and the
  coverage gate. Refused: the lens passes are subagent spawns, which no verb can make, and the gate
  is a judgment over a catalog the model has already read. What would remain is `report dedup` and
  `report file` under a second name.
- **A verb that runs the coverage gate over the catalogs.** Refused: it could emit the row *labels*
  in the right order and nothing else — the Status column is the whole answer and it is a judgment.
  A verb that printed ten empty rows would look like a gate and check nothing.
- **A verb that files the whole finding set at once.** Refused twice over: it collapses the human's
  pick, which is the decision this skill's shape exists to protect, and it would need a second
  create envelope beside `report file`'s.
- **An `auditCatalogs` arm that removes or replaces a shipped smell.** Refused: a repo that can
  delete a shipped row can silently shrink the covered surface, and the gate's promise is that two
  runs — in one repo or two — checked the same list plus whatever was added. The key carries paths
  and nothing else, so the add-only property is a fact about the decoded shape rather than a rule a
  caller has to remember.
- **A whole-repo mode, and a by-name package lookup.** Refused: an unscoped walk produces findings
  no later run can be compared against, and a package name resolves differently in every repo while
  a path resolves in this one.
- **An unattended mode that files without the pick.** Refused for now, not forever. The measured
  ungated run filed thirty findings and ten survived triage; an automated shape is worth revisiting
  only once the gated one has a record of what a human keeps.

## The three lens briefs

Three explorer subagents, spawned in one tool-call block, tool-restricted to read-only — no `Edit`,
no `Write`, no `NotebookEdit`.

**Every brief carries all six of these**, and a brief missing one produces a pass that reads like a
generic code review:

1. **The scope** — the one repo-relative folder path, verbatim.
2. **The lens framing** — one of the three below, verbatim.
3. **The architecture vocabulary** — as read from `.glossary/LANGUAGE.md` this run.
4. **The domain vocabulary** — as read from `.glossary/TERMS.md` this run.
5. **The deletion test**, as the primary heuristic for a shallow module: would deleting this module
   concentrate complexity — it was earning its keep — or merely move it? *Concentrates* is the
   signal.
6. **The decided ground** — the records under `decisionsDir` that touch the scope, so the pass does
   not propose something already settled.

**Frame each lens as an instruction, never as a persona.** "You are a senior testability auditor"
costs measurable accuracy against "focus this pass on testability"; the framing is a direction for
attention, not a costume.

> **Lens A — Locality.** "Focus this pass on **locality of change**. Where do related concepts live
> apart? Where would one user-visible change require edits in N files? Where does fixing a bug in
> concept X mean also touching unrelated code? Treat scattered ownership of one idea as the primary
> friction signal."

> **Lens B — Testability.** "Focus this pass on **testability through interfaces**. Where do tests
> assert against internal seams — private helpers, intermediate state — instead of the module's
> external interface? Where are pure functions extracted *only* for testability, leaving the
> call-site coupling untested? Where can the module *not* be exercised through its interface from a
> test? The interface is the test surface; flag anywhere that is violated."

> **Lens C — Vocabulary.** "Focus this pass on **vocabulary fidelity**. Where do names lie about
> what the code does — the function says one thing, the body does another? Where do the canonical
> domain terms not appear in the code that handles them? Where do internal type and symbol names
> diverge from the user-facing or domain-facing names? Treat naming friction as a signal of a
> conceptual gap, not of surface polish."

**Each pass reports the files it opened.** A report that names none did not run, and counting it as
an empty finding set is how a two-lens audit gets recorded as a three-lens one.

## The coverage gate

One row per smell, in order, three statuses:

| Status | What it commits you to |
|---|---|
| `✓ checked` | you looked for this smell in this scope and found none. Not "it did not come up." |
| `— N/A` | the smell cannot apply to this code shape, plus the one-line reason. A reason like "no time" is a `✓ checked` that is lying. |
| `✗ found` | it is present, with the file or symbol, and the finding number that covers it. A `✗ found` with no finding is an unfiled observation. |

The table shape:

```markdown
| Smell | Status | Notes |
|---|---|---|
| 1. Shallow module | ✗ found | finding 2 (`adapt-payload`) |
| 2. Pass-through layer | ✓ checked | none |
```

**Ordering is the add-only rule made mechanical.** Emit every row of [SMELLS.md](SMELLS.md) first,
in its order, then the rows of each catalog the `auditCatalogs` key names, in the order the key
lists them. A declared catalog whose row restates a shipped smell contributes a second row rather
than replacing the first; the shipped row is the one that counts, and the duplication is worth
saying out loud in the notes.

**The gate is an accounting step, never a filed artifact.** It goes back to the human with the
finding table and stops there.

Three answers the `auditCatalogs` row can carry, and what each means for the gate:

- **`default`** — the repo declared none. Run the shipped catalog alone. This is the ordinary case.
- **`declared`** — read each path. A path that does not resolve is a fact to report beside the
  table, not a reason to skip the gate: run the shipped rows and say which catalog was unreadable.
- **`malformed`** — the declared list did not decode, and the reason names what was rejected. Run
  the shipped catalog alone and relay the reason. Do not guess at the intended list.

## The finding table

The terminal artifact of the audit half. One row per consolidated finding, ranked, handed to a human
who picks.

| Column | Content |
|---|---|
| Rank | 1 is the costliest to leave. Rank on cost, never on how interesting the finding was to make. |
| Smell | the catalog smell it matches, by number and name, or `—` when the lens passes found something the catalog has no row for. |
| Severity | `high` / `medium` / `low` — your read of the cost of leaving it. |
| Location | repo-relative paths and symbols. No machine-local paths, ever. |
| Direction | the deepening direction, with its [DEEPENING.md](DEEPENING.md) dependency category. Non-binding. |
| Lenses | which of the three raised it — `3 of 3`, or `Vocabulary only (1 of 3 — divergent, preserved)`. |
| Duplicate | the open issue that already covers it, or `none`, or `dedup UNKNOWN` when the read did not answer. |
| Recommendation | exactly one of the two words below. |

**The recommendation vocabulary is two words, and neither of them acts.**

- **`file`** — nothing open covers this; it should become an issue.
- **`note`** — an open issue covers it; what this finding adds belongs there as a comment.

A row whose Duplicate column reads `dedup UNKNOWN` still gets a recommendation, and the row says the
check did not run. A duplicate is cheap for triage to close; a lost finding is gone.

**There is no third word and no default.** A human picks the rows; unpicked rows are not filed, not
"filed later", and not carried into a follow-up session. The table dies with the run, and that is the
gate working.

## Mapping a finding into report's six sections

A picked `file` row becomes an intake issue in exactly the shape [`report`](../report/SKILL.md)
files one — type-blind, `status:needs-triage`, no type and no priority. The mapping:

| Section | From the finding |
|---|---|
| `## Summary` | two or three plain sentences a triager grasps on a skim. Say what is shaped wrong, not that an audit ran. |
| `## What I was doing` | "architecture audit of `<scope>`, `<lens(es)>` pass." |
| `## What I observed` | the friction itself, in the architecture vocabulary, with files and symbols and the smell it matches. This is the section triage acts on. |
| `## Why it matters` | the cost of leaving it, in locality and leverage terms: what scatters, what the interface fails to hide, what cannot be tested through it. Honest about uncertainty. |
| `## Pointers` | repo-relative paths, the domain term the register gives this concept, the lens attribution, the smell number, and any settled decision the finding touches. |
| `## Suggested next step (non-binding)` | the deepening direction plus its dependency category, labelled a guess. |

**The title is type-neutral and names what was seen**, under about seventy characters. "The retry
policy is written twice and the two have drifted" names something; "Refactor the retry layer"
prescribes, and prescribing here is the classification triage owes.

A picked `note` row skips all of this: it adds to the existing issue only what that issue does not
already carry, through `fabrika report note`.

## What this skill's shape owes elsewhere

- **It does not fork.** It declares neither `context: fork` nor `background: true`, because a human
  is waiting on the finding table and a backgrounded run's table dies with its context — the same
  clause-2 failure the conversational skills have.
- **It declares no `arguments:`.** Its scope is a path, not a number, so the frontmatter rule that
  binds a number-taking skill does not reach it; step 1 of the `SKILL.md` is the whole scope
  contract.
- **Its GitHub access is the `report` verbs' and nothing else.** It makes no direct forge call, so
  the REST-only rule binds it through those verbs rather than through any invocation of its own.
