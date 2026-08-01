# fabrika CLI interface convention + contract-spec format

Reference for two audiences, one artifact apart.

**Part 1** is the interface every fabrika verb meets, whoever writes it. **Part 2** is the shape of
the **contract spec** an authoring session emits for the verbs its skill needs — the document a
`write-code` agent implements from, with no access to the session that wrote it.

The order is not decorative. fabrika's architecture is a two-layer split: deterministic work pushed
maximally into CLI verbs, each skill a thin wrapper carrying only irreducible judgment ([#4631
founder given](https://github.com/kamp-us/phoenix/issues/4631)). The method that fills that split is
derivation: an authoring session works out which verbs its skill needs and writes the spec, and
**that spec is the contract the CLI implements** ([#4638
ruling](https://github.com/kamp-us/phoenix/issues/4638)). The v1 scripts under
[`../../kampus-pipeline/`](../../kampus-pipeline/) are a frozen baseline to compare against, never a
source of truth to port from. A spec clause that says "same as the v1 script" has derived nothing.

---

## Part 1 — the interface convention

Five rules. Each states what a verb owes its caller and cites the ruling or finding it comes from.

### 1. `--help` is the interface — an agent discovers a verb at runtime, never by reading its source

Source: the founder given on map [#4631](https://github.com/kamp-us/phoenix/issues/4631) (runtime
discoverability is first-class), sharpened by the [#4635](https://github.com/kamp-us/phoenix/issues/4635)
survey of the v1 CLI, which found root help lists every tool with a purpose and a citation while
per-tool help documents subcommands and exit codes inline.

- Every verb, every subcommand, and every flag carries a one-line description. A flag with no
  description is an undocumented input.
- `--help` states, for the verb: what it answers, its output **shape** (rule 2), its exit codes
  (rule 3), and at least one example (rule 4).
- The index of verbs is **derived from the registry**, never hand-maintained. v1's
  `pipeline-cli commands compact` is the working precedent: it reads name + description off the same
  `Command` objects the router dispatches on, so a new verb appears automatically and a verb shipped
  without a description is mechanically detectable
  ([`packages/pipeline-cli/src/tools/commands/commands.ts`](../../../packages/pipeline-cli/src/tools/commands/commands.ts)).
  A parallel hand-written list rots; that is the defect the derived index replaced.

### 2. Results by value on stdout; the shape is documented, not guessed

Source: the [#4635](https://github.com/kamp-us/phoenix/issues/4635) finding that the convention exists
de facto but uncodified — output shape (JSON vs table vs line grammar) is described inconsistently in
prose across the 76 v1 tools. The rule itself is the CLI statement of
[`.patterns/skill-script-io-contract.md`](../../../.patterns/skill-script-io-contract.md), which
already binds the shell half of the same pipeline.

- **Stdout is the answer. Everything else is stderr.** Progress, warnings, refusal reasons and scope
  statements are diagnostics.
- Every verb declares its answer channel as exactly one of:
  - **machine** — stdout is parsed, split, or fed to another command. Nothing but the answer lands
    there, and the shape is fixed (a JSON object with named keys, or a line grammar).
  - **prose** — stdout is a human-readable verdict the caller greps for a state word.
- The declared shape appears in `--help` and in the contract spec, with an example of the actual
  bytes. Prose describing a shape is not a shape.
- **The positive answer is a positive token, never an absence.** A verb whose "nothing found" answer
  is empty stdout is byte-identical to a verb that never ran. Print a state word.

### 3. The exit status is the answer; empty stdout never is

Source: [`.patterns/skill-script-io-contract.md`](../../../.patterns/skill-script-io-contract.md)'s
exit taxonomy, and the verdict-vs-invocation rule proven in v1 at
[`packages/pipeline-cli/src/exit-codes.ts`](../../../packages/pipeline-cli/src/exit-codes.ts)
(#4208, #4219).

- **`0` means "I produced the answer on stdout". Any non-zero means "I could not produce one"** —
  UNKNOWN, never the permissive reading. A caller reads the status before the bytes.
- **A verdict a verb proved must never share an exit code with a failure to invoke.** `1` is what
  the Effect CLI returns for a usage error and what a failed module load returns; `127` is the
  shell's missing-binary code. A proven verdict seated on either is unreadable as proof, because
  `[ $? -ne 0 ]` then reads "never ran" as "ran and proved it". So:

  | Code | Reserved for |
  |---|---|
  | `0` | the answer was produced on stdout |
  | `1` | usage error, or the verb failed to run |
  | `127` | the verb never ran at all (unresolved binary) |
  | `3`+ | the verb's own proven outcomes, each enumerated in `--help` |

- A verb whose result crosses a pipe keeps its exit code binary (`0` / non-zero) and puts the
  discriminator in a stdout state word: a meaningful code does not survive `xargs`.

### 4. Fail closed on missing scope or state

Source: [ADR 0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md).

- A verb that **judges** states the scope its verdict rests on, on its own answer channel, and
  **reds on zero scope**. "I scanned nothing and found no violations" is a pass a guard must never
  emit.
- A verb that only **supplies** an input decides, once and in its header, whether an empty result is
  a fact or a failed read — and says which. An empty team roster is a fact; an empty changed-file
  list on a pull request is a failed read.
- Assert on the positive shape required, never on the absence of an imagined failure. A missing
  field read as `undefined` is not zero, and `undefined === 0` is `false` — that comparison is how a
  guard once vouched for a corpus it never scanned.

### 5. Every documented invocation is a plain literal command string

Source: [#4641](https://github.com/kamp-us/phoenix/issues/4641), closed with the mechanism understood,
and [ADR 0232](../../../.decisions/0232-agents-execute-skill-scripts-never-source-them.md).

The harness's isolation verifier is a **syntactic check on the command string**. It does not consult
process env and does not touch the filesystem: `$USER` and `$PWD` are refused while genuinely set, a
symlink to a nonexistent target runs and fails with an ordinary `127`, and `$HOME` appears to be
special-cased. So no env-injection mechanism of any kind can make a variable-rooted invocation
usable at an agent's top-level command.

- A fabrika verb is invoked as a plain `fabrika-cli <verb> …` command string. No `$VAR`, no
  `${VAR:-default}`, no command substitution, no `source`.
- **Examples in `--help` and in a contract spec are held to the same rule.** An example an agent
  cannot paste verbatim is not an example.
- A verb never requires an env var to *locate* itself. Configuration may still arrive by env
  (a session id, a target repo), and each such variable is named in `--help` with its default and
  what happens when it is unset.

### Enforcement

There is no mechanical conformance guard yet, and that absence is deliberate: with zero fabrika verbs
in existence a repo-wide guard has zero scope and reds on itself (ADR 0092). Enforcement starts as
per-verb tests in the first verb package, which rides with the wave-0 pilot in epic
[#4650](https://github.com/kamp-us/phoenix/issues/4650). Until then this doc is what a reviewer holds
a verb to.

---

## Part 2 — the contract-spec format

A **contract spec** is what an authoring session emits per skill: the verbs that skill needs, fully
specified. It is the deliverable of the derivation the [#4638](https://github.com/kamp-us/phoenix/issues/4638)
ruling mandates, and it is the input a `write-code` agent builds from.

**Where it lands.** One `contract.md` beside the skill it serves —
`claude-plugins/fabrika/skills/<skill>/contract.md` — landing in the same pull request as the
`SKILL.md` the session authored. The implementing pull request links back to it.

**The bar it must clear.** A fresh `write-code` agent implements every verb in the spec without
reading the authoring transcript, without asking the session a question, and without opening a v1
script.

### Required sections

A spec has a header and one block per verb.

**Header** — the skill it serves, the authoring-brief issue, and the date. Nothing else.

**Verb inventory** — one row per verb: name, one-line purpose, and the split test that put it here
(what makes this deterministic rather than judgment the wrapper keeps). A verb whose row cannot state
that test belongs in the skill, not the CLI.

**Per verb, in this order:**

| Section | Content |
|---|---|
| Invocation | the literal command string, with subcommands. Rule 5 applies. |
| Inputs | one row per flag: name, type, required or optional, default, and the description text that becomes the flag's help string verbatim. |
| Output | the channel (machine or prose), the exact shape, and what an empty answer means. |
| Exit status | every code the verb can return and its trigger, obeying the reserved table in rule 3. |
| Errors | one row per named failure: message text, stream, exit code, and whether it is a refusal (fail-closed) or a usage error. |
| Scope | for a judging verb: what it scans, and what zero scope does. |
| Examples | at least one literal invocation with its expected stdout, byte for byte. |
| Grounding | the incidents, rulings, or ADRs the behavior encodes — one line each. |

### Completeness test

A spec is complete when all six hold. Each is checkable by reading the spec alone, which is the
point: an implementer can tell an unfinished spec from a finished one before starting.

1. Every flag has a type and, if optional, a default.
2. Every stdout shape is shown by an example, not only described.
3. Every non-zero exit code is enumerated with the condition that produces it.
4. Every error names its message, its stream, and its code.
5. Every judging verb states its scope and its zero-scope behavior.
6. No clause defers to a v1 script, another skill's prose, or the authoring session. Deferral is the
   [#4638](https://github.com/kamp-us/phoenix/issues/4638) failure: the spec is the contract, so a
   spec that points elsewhere has not derived one.

### Worked example

Illustration only. It is not a commissioned verb, and it does not pre-commit the `/adr` contract —
that one is derived by its own authoring session as the wave-0 pilot in
[#4650](https://github.com/kamp-us/phoenix/issues/4650). It is here to show a complete block at the
level of detail the completeness test demands.

---

**Verb:** `decisions next-id` — the next unused ADR number.
**Split test:** deterministic. Scan filenames, take the max, add one. No judgment.

**Invocation**

```
fabrika-cli decisions next-id [--dir <path>]
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
$ fabrika-cli decisions next-id
0233
```

```
$ fabrika-cli decisions next-id --dir /nonexistent
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
