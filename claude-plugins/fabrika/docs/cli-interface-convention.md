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
  (rule 3), and at least one example (rule 5).
- The index of verbs is **derived from the registry**, never hand-maintained. v1's
  `pipeline-cli commands compact` is the working precedent: it reads name + description off the same
  `Command` objects the router dispatches on, so a new verb appears automatically and a verb shipped
  without a description is mechanically detectable
  ([`packages/pipeline-cli/src/tools/commands/commands.ts`](../../../packages/pipeline-cli/src/tools/commands/commands.ts)).
  A parallel hand-written list rots; that is the defect the derived index replaced.
- **A `--help` that resolves is proof the path exists — up to the last node that takes subcommands.**
  `fabrika <unknown> …` is refused before the CLI runner sees it: the reason on stderr, nothing on
  stdout, exit `1`. That holds at the group level and inside a group, with or without `--help`, and
  however many invalid tokens follow. It has to be a fabrika-side guard because the runner answers the
  probe otherwise — `effect`'s `Command.runWith` processes action flags before it inspects parse
  errors, and `--help` is an action flag, so it printed the deepest valid prefix's help and exited `0`
  while discarding the whole invalid tail ([#4822](https://github.com/kamp-us/phoenix/issues/4822)).
- **An operand a leaf verb never declared is refused too**, at the argument layer rather than the path
  layer. Every leaf declares a hidden trailing catch-all, so the parser hands the verb whatever its own
  arguments left, and the verb refuses on stderr with exit `1` (rule 3's usage-error code) instead of
  binding none of them and answering anyway. `fabrika adr next bogus` refuses; `fabrika adr resolve
  0164 0023` still absorbs both ids, because a variadic argument consumes its operands before the
  catch-all sees them ([#4828](https://github.com/kamp-us/phoenix/issues/4828)).
- **The residual caveat: a global flag placed *before* the group name ends the path guard's walk.**
  `fabrika --log-level info triage --help` exits `0` with root help even though `triage` names no
  group. The walk stops at the first `-`-prefixed token because a later bare token may be that flag's
  value (`--log-level debug`), and reading a value as a subcommand would refuse a valid invocation — a
  miss is the fail-safe direction for a guard whose only output is a refusal. This stays a documented
  residual rather than a code fix: telling a flag's value from a subcommand needs the parser's own
  per-flag arity, which the published `effect` types do not expose, so a fabrika-side fix would carry a
  hand-maintained list of which global flags take a value — the parallel-list rot this same rule
  forbids for the verb index.

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
  | `2` | no implementation could be resolved — the binary was found, the verbs were not |
  | `127` | the verb never ran at all (unresolved binary) |
  | `3`+ | the verb's own proven outcomes, each enumerated in `--help` |

  `2` is the seat between the two invocation failures. `127` is the shell reporting that nothing
  ran; `1` is a verb reporting that it ran and the caller asked wrongly. Between them sits the case
  where `fabrika` itself started, could not reach a working set of verbs — an unlinked
  dependency, a repo-local install it could not execute — and has something specific to say about
  it. Seating that on `1` would make it indistinguishable from a typo in a flag ([#4666](https://github.com/kamp-us/phoenix/issues/4666)).

- **The `3`+ band is scoped to the verb group that seats it. A code above the reserved band means one
  thing *within* its group and carries no cross-group uniqueness obligation.** Two shipped shapes are
  both correct, and a group picks by whether its verbs share refusal meanings:

  - **Per verb, no shared table** — the `3`+ row above read literally. Permitted, and today shipped
    nowhere: `adr` was the standing example until its five verbs seated `NO_SUBJECT` on two numbers
    and `3` on four meanings, which is what the shape costs when a group's verbs *do* share refusal
    meanings (#5294). What survives of it is `report dedup`, whose two codes sit outside its group's
    table — the residue tracked by #5296.
  - **Per group, one shared table** — `report`, `triage`, `review`, `adr`, `spend` and `wire` each ship a
    `<group>/codes.ts` that every verb in the group allocates from, so a code means one thing across
    the group whichever verb produced it. That is a **tightening** a group chooses, not a further
    obligation this rule imposes.

  Neither shape reaches across a group boundary.
  [`triage/codes.ts`](../../../packages/fabrika-cli/src/triage/codes.ts) seats `12` as *the issue is
  human-filed*; [`review/codes.ts`](../../../packages/fabrika-cli/src/review/codes.ts) seats `12` as
  *the live head moved past the inspected `--sha`*. Those are two namespaces, not one collision.

- **The `report` ↔ `triage` ↔ `review` code-for-code alignment is a deliberate, bounded courtesy —
  not a repo-wide namespace.** Those three groups hold `3`, `5`, `6`, `7`, `8`, `9`, `10` and `11` on
  one meaning each, and `triage` and `review` *import* the constants from `report` rather than
  restating numerals, so a drift there is unrepresentable rather than merely detectable. The reason is
  one caller commonly driving all three in a single sweep.
  [`exit-code-alignment.ts`](../../../packages/fabrika-cli/src/exit-code-alignment.ts) mechanizes
  exactly that scope and no more: it checks each aligning group against the **base** and never
  pairwise against a sibling. Above the shared overlap each group's private band is its own —
  `review`'s `12`–`15` and `triage`'s `12`–`13` are not required to clear each other, and do not.

  [`wire/codes.ts`](../../../packages/fabrika-cli/src/wire/codes.ts) is the shipped counter-example.
  It aligns to nothing, and is *registered* as unaligned with its reason so the exemption carries
  information instead of reading as an oversight. It legitimately reuses `4`, `5`, `6` and `8` —
  `MALFORMED` / `EMPTY_ARTIFACT` / `ARTIFACT_UNKNOWN` / `UNUSABLE_FIELDS` against `report`'s
  `BAD_SECTIONS` / `LEAKED_PATH` / `BARE_AT_PATH` / `WRITE_UNKNOWN` — and reuses `3` and `7` besides.
  Under a cross-group clearance rule `wire` would be the largest violation in the package. It is not a
  violation at all.

- **One condition would turn a cross-group reuse into a defect: a reader that resolves an exit code
  without knowing which group produced it.** None exists today, and the interface is what keeps it
  that way. Every invocation names its group (`fabrika <group> <verb> …`, rule 5); each `--help`
  enumerates only the codes that verb can reach; and the runtime taxonomy verb is per group —
  `fabrika triage codes` prints `TRIAGE_EXIT_TABLE`, `fabrika wire codes` prints `WIRE_EXIT_TABLE`,
  with no cross-group table and no shared lookup. Add such a reader — a dispatcher, a shared decoder,
  a wrapper that maps a numeral to a meaning before it knows the group — and cross-group clearance
  becomes a real obligation to encode. Until then, re-seating a shipped code to clear a sibling buys
  nothing and breaks that group's own symmetry.

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

- A fabrika verb is invoked as a plain literal command string — no `$VAR`, no `${VAR:-default}`, no
  command substitution, no `source`.
- **The literal is `fabrika`.** That name is now fixed, closing the deferral this rule carried
  to [#4650](https://github.com/kamp-us/phoenix/issues/4650): every fence in every fabrika skill
  writes `fabrika <group> <verb> …` and nothing else. The command and the package are deliberately
  **different names** — `fabrika` is the `bin` *key* of the `@kampus/fabrika-cli` package, which
  keeps its name on npm and its directory at `packages/fabrika-cli/`
  ([#4784](https://github.com/kamp-us/phoenix/issues/4784)). [Delivery](#delivery--one-name-two-installs)
  below is how the command comes to resolve.
- **Examples in `--help` and in a contract spec are held to the same rule.** An example an agent
  cannot paste verbatim is not an example.
- A verb never requires an env var to *locate* itself. Configuration may still arrive by env
  (a session id, a target repo), and each such variable is named in `--help` with its default and
  what happens when it is unset.

<a id="delivery--one-name-two-installs"></a>
#### Delivery — one name, two installs, both of them real

`fabrika` is delivered as a **global install** of `@kampus/fabrika-cli`. On startup the binary
finds the **repo root** above the working directory, asks Node's own resolver what copy that root
installed, and hands the invocation to it. This is the shape [turbo](https://turborepo.com) ships
(`crates/turborepo-shim/`) — a global entry point that defers to the version the repo pins —
reimplemented in fabrika's own TypeScript
([#4784](https://github.com/kamp-us/phoenix/issues/4784)).

The property that buys is a **repo-pinned version**: a repo carrying `@kampus/fabrika-cli` in its
`devDependencies` gets that version from a bare fence, whatever each machine's global happens to be.

Branches, and the reason this is not the resolution ladder [#4784](https://github.com/kamp-us/phoenix/issues/4784)
rejected: **a repo-local install is a real installed package, and the global is a real installed
package.** Neither is chosen by testing whether a file exists and guessing that it will run. Tiers
that can only be right or loudly absent are fine; tiers that can be quietly wrong are the defect.

The branch that makes that concrete is the degenerate one. **A repo root that pins the package but
has not installed it, or whose install is corrupt, runs the global and says so loudly** — naming the
global's version beside the version the root manifest declared, silenceable with
`FABRIKA_GLOBAL_WARNING_DISABLED`. It is not an error: the worst outcome is that the global runs.
**No repo root at all is the one silent branch**, deliberately, so a global-only invocation stays
quiet. Separating those two is the whole point — collapsing them is what makes a delegation quietly
wrong.

Three environment variables belong to the delivery layer rather than to any verb, and none of them
locates the binary, so none weakens the rule above: `FABRIKA_DEBUG` prints one stderr line naming
which copy served the invocation; `FABRIKA_GLOBAL_WARNING_DISABLED` silences the degenerate branch's
warning; `FABRIKA_SKIP_INFER` is the recursion guard for a caller that cannot alter argv. The guard
the CLI itself uses on the child is the **`--skip-infer` flag**, stripped before any verb sees it,
and the child is additionally handed the user's original directory as `FABRIKA_INVOCATION_DIR`
because its own cwd is set to the repo root.

### 6. fabrika calls nothing outside fabrika

Source: founder ruling, in-session 2026-08-01, on the wave-0 pilot's derived contract
([#4704](https://github.com/kamp-us/phoenix/issues/4704) / [#4724](https://github.com/kamp-us/phoenix/pull/4724)).

**No fabrika skill and no fabrika verb invokes `pipeline-cli`, or anything else under
`claude-plugins/kampus-pipeline/`.** Every deterministic step a skill needs is implemented in
fabrika's own verb package. Where v1 already solves the same problem, read its source to learn the
semantics and the scars, then implement fabrika's own — duplication is the accepted cost.

The reason is the **deletion test**: a fabrika that calls v1 can never be the thing that replaces it,
because every call is a tether keeping the old tree alive. Duplication costs a second implementation
during the transition. A tether costs the ability to ever delete anything.

Two consequences worth stating, because both were live questions on the pilot:

- **This supersedes "fabrika may call `pipeline-cli` but never grows into it."** That earlier posture
  produced wrapper verbs whose only job was relaying an upstream answer — seven verbs for one skill,
  two of them pure pass-throughs. Extrapolated across the skill corpus it rebuilds `pipeline-cli` by
  accretion, which is the outcome the posture existed to prevent.
- **Not every v1 call becomes a fabrika verb; some become nothing.** Where the thing being computed
  is already *enforced* elsewhere — a CI gate, a merge check — fabrika does not compute a second
  answer to it. The pilot's `adr classify` was dropped for exactly this: `cp-classify` decides
  control-plane membership at the merge gate, and a fabrika copy could contradict the gate on a
  merge-gating question. Ask whether the skill needs the answer, or only needs to expect it.

An authoring brief's "assumable verbs" field is therefore a list of **prior art to read**, not a list
of things to call.

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

A spec is complete when all seven hold. Each is checkable by reading the spec alone, which is the
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

   Checks 1–6 are all *presence* tests, and a spec can pass every one of them while leaving its core
   uninvented: `adr sweep` declared its flags, its shapes, its codes, its errors and its scope, and
   printed two example scores derived from a ranking function the spec never gave. Two implementers
   read that and ship two different verbs, each skill's judgment layer tuned against a ranking that
   moves under it ([#4735](https://github.com/kamp-us/phoenix/issues/4735), ADR
   [0247](../../../.decisions/0247-a-spec-example-value-is-derivable-or-absent.md)). An example that
   *looks* verifiable and is not is worse than no example, because a reader treats the number as a
   contract.

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
