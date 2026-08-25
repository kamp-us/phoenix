# fabrika contract-spec format

A **contract spec** is what an authoring session emits per skill: the verbs that skill needs, fully
specified. It is the deliverable of the derivation the
[#4638](https://github.com/kamp-us/phoenix/issues/4638) ruling mandates — the session works out
which deterministic work belongs in the CLI and writes the contract the CLI implements — and it is
the input a `write-code` agent builds from.

This page is the reference for that document's format: its required sections, the completeness test
it must clear, and a worked example. The runtime discipline every verb the spec describes owes its
caller is the sibling page's subject: [the CLI interface convention](interface-convention.md).

**Where it lands.** One `contract.md` beside the skill it serves —
`claude-plugins/fabrika/skills/<skill>/contract.md` — landing in the same pull request as the
`SKILL.md` the session authored. The implementing pull request links back to it.

**The bar it must clear.** A fresh `write-code` agent implements every verb in the spec without
reading the authoring transcript, without asking the session a question, and without opening a v1
script.

**What it is at runtime.** The authoring spec is `contract.md`'s primary role; runtime lookup is
not a role it carries. A running shell whose question has one addressable answer — an exit-code
row, a grammar table, a terminal vocabulary, one section — gets it from a CLI verb
(`fabrika wire doc-section --heading <x> < <skill-base>/contract.md`, or a dedicated lookup verb
like `fabrika triage codes`), never by opening the whole contract. Only a judgment-shaped pass —
authoring a skill, reviewing one, resolving an ambiguity the verbs cannot address — opens the file,
and even then section-at-a-time. The why is ADR
[0291](../../../.decisions/0291-runtime-lookups-verb-served.md) as amended by ADR
[0296](../../../.decisions/0296-contracts-are-read-by-section.md); the pointer-sizing side of the
same split is [skill-conventions §2](skill-conventions.md).

## Required sections

A spec has a header and one block per verb.

**Header** — the skill it serves, the authoring-brief issue, and the date. Nothing else.

**Verb inventory** — one row per verb: name, one-line purpose, and the split test that put it here
(what makes this deterministic rather than judgment the wrapper keeps). A verb whose row cannot state
that test belongs in the skill, not the CLI.

**Per verb, in this order:**

| Section | Content |
|---|---|
| Invocation | the literal command string, with subcommands. [Rule 5](interface-convention.md#5-every-documented-invocation-is-a-plain-literal-command-string) applies. |
| Inputs | one row per flag: name, type, required or optional, default, and the description text that becomes the flag's help string verbatim. |
| Output | the channel (machine or prose), the exact shape, and what an empty answer means. |
| Exit status | every code the verb can return and its trigger, obeying the reserved table in [rule 3](interface-convention.md#3-the-exit-status-is-the-answer-empty-stdout-never-is). |
| Errors | one row per named failure: message text, stream, exit code, and whether it is a refusal (fail-closed) or a usage error. |
| Scope | for a judging verb: what it scans, and what zero scope does. |
| Examples | at least one literal invocation with its expected stdout, byte for byte. |
| Grounding | the incidents, rulings, or ADRs the behavior encodes — one line each. |

## Completeness test

A spec is complete when all eight hold. Each is checkable by reading the spec alone, which is the
point: an implementer can tell an unfinished spec from a finished one before starting.

1. Every flag has a type and, if optional, a default.
2. Every stdout shape is shown by an example, not only described.
3. Every non-zero exit code is enumerated with the condition that produces it.
4. Every error names its message, its stream, and its code.
5. Every judging verb states its scope and its zero-scope behavior.
6. No clause defers to a v1 script, another skill's prose, or the authoring session. Deferral is the
   [#4638](https://github.com/kamp-us/phoenix/issues/4638) failure: the spec is the contract, so a
   spec that points elsewhere has not derived one.
7. **Every value an example prints is derivable from the spec.** A verb that emits a computed value
   specifies the computation — every input to it, down to the tie-break and the rounding — or prints
   no example value. Where the value also depends on data outside the spec, the example names data a
   reader can hold fixed, such as a committed fixture, rather than a corpus that moves under it.
8. **Every outcome the verb can reach has a code.** Walk the verb's *states* and check each one names
   a code.

Checks 1–6 are all *presence* tests, and a spec can pass every one of them while leaving its core
uninvented — that is check 7's finding ([#4735](https://github.com/kamp-us/phoenix/issues/4735),
[ADR 0247](../../../.decisions/0247-a-spec-example-value-is-derivable-or-absent.md)): an example that
*looks* verifiable and is not is worse than no example, because a reader treats the number as a
contract. Check 8 runs check 3 backwards — 3 walks the codes and asks what produces each, so it only
sees what the spec already wrote down, and a state the spec never mentioned is invisible to it. An
unmentioned reachable state lands on `1`, which [rule 3](interface-convention.md#3-the-exit-status-is-the-answer-empty-stdout-never-is)
reserves for a failure to invoke, so the spec's silence hands the caller a **proven** refusal it
cannot tell from a broken binary ([#4736](https://github.com/kamp-us/phoenix/issues/4736) — the
verdict-versus-invocation collision of #4208 / #4219). Checks 7 and 8 are the **outcome-completeness**
pair: 7 that the spec derives every value it prints, 8 that it names every outcome it can reach.

## Worked example

Illustration only. It is not a commissioned verb, and it does not pre-commit the `/adr` contract —
that one is derived by its own authoring session. It is here to show a complete block at the
level of detail the completeness test demands.

---

**Verb:** `decisions next-id` — the next unused ADR number.
**Split test:** deterministic. Scan filenames, take the max, add one. No judgment.

**Invocation**

```
fabrika decisions next-id [--dir <path>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--dir` | string | no | `.decisions` | the directory of `NNNN-slug.md` decision records to scan |

**Output** — machine channel. One line, the zero-padded four-digit id, newline-terminated. There is
no empty answer: see Scope.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the id was produced on stdout |
| `1` | usage error (unknown flag), or the directory could not be read |
| `3` | the directory was read and held zero `NNNN-slug.md` files — a refusal, see Scope |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `decisions: cannot read <dir>: <reason>` | 1 | refusal |
| `decisions: scanned <dir>, 0 decision records — refusing to answer (ADR 0092)` | 3 | refusal |
| `decisions: <dir> holds a record with an unparseable id: <name>` | 1 | refusal |

**Scope** — every file in `--dir` matching `NNNN-slug.md`. Zero matches is a **failed read, not an
answer**: this repo always has decision records, so an empty scan means the wrong directory or a
broken read, and answering `0001` would silently propose an id that collides with an existing record.
The scope line goes to stderr, because this verb's answer channel is machine.

**Examples**

```
$ fabrika decisions next-id
0233
```

```
$ fabrika decisions next-id --dir /nonexistent
decisions: cannot read /nonexistent: ENOENT
$ echo $?
1
```

**Grounding**

- ADR 0092 — zero scope reds; the empty scan is a refusal, not `0001`.
- #4208 / #4219 — the proven refusal sits on `3`, never on `1` or `127`, so a caller can tell a
  proven empty scan from a verb that never ran.
- Serialized authoring: concurrent id derivation races, so a caller that mints records in parallel
  pre-assigns ids rather than calling this verb twice.
