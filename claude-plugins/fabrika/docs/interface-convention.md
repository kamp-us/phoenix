# fabrika CLI interface convention

Reference for the interface every fabrika verb meets, whoever writes it: `--help`
discoverability, stdout discipline, exit-status semantics, scope behavior, invocation literals,
and delivery.

The contract-spec format — the shape of the `contract.md` an authoring session emits for the
verbs its skill needs — is the companion page:
[the contract-spec format](contract-spec.md).

fabrika's architecture is a two-layer split: deterministic work pushed maximally into CLI verbs,
each skill a thin wrapper carrying only irreducible judgment ([#4631
founder given](https://github.com/kamp-us/phoenix/issues/4631)). The method that fills that split
is derivation: an authoring session works out which verbs its skill needs and writes the spec,
and **that spec is the contract the CLI implements** ([#4638
ruling](https://github.com/kamp-us/phoenix/issues/4638)). v1 — `claude-plugins/kampus-pipeline/`,
`packages/pipeline-cli/` — is retired and kept only as a frozen comparison baseline, never a
source of truth to port from; a spec clause that says "same as the v1 script" has derived nothing
(ADRs [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md) /
[0303](../../../.decisions/0303-retire-kampus-pipeline-plugin.md)).

---

## Rules

Five rules. Each states what a verb owes its caller and cites the ruling or finding it comes from.

### 1. `--help` is the interface — an agent discovers a verb at runtime, never by reading its source

Source: the founder given on map [#4631](https://github.com/kamp-us/phoenix/issues/4631) (runtime
discoverability is first-class), sharpened by the [#4635](https://github.com/kamp-us/phoenix/issues/4635)
survey of the v1 CLI, which found root help lists every tool with a purpose and a citation while
per-tool help documents subcommands and exit codes inline.

- Every verb, every subcommand, and every flag carries a description. A flag with no description is
  an undocumented input.
- **Two audiences read a verb's help, so a verb declares two descriptions, not one.** The parent
  group's `SUBCOMMANDS` list is scanned by a human choosing a verb; the verb's own `DESCRIPTION`
  block is read by whoever is about to call it. They want opposite things, and one string cannot be
  both:
  - the **short** description (`Command.withShortDescription`) is the list row — **one sentence**
    saying what the verb answers, no output shape, no exit codes, no example. The renderer neither
    wraps nor truncates it, so it must fit one terminal line beside the padded name column; the
    budget and the checks are `packages/fabrika-cli/src/short-description.ts`, asserted for every
    registered leaf by `short-description.unit.test.ts`.
  - the **long** description (`Command.withDescription`) is the verb-level contract below.

  Reusing the long form as the list row is the defect this split fixes: `fabrika ship --help` emitted
  rows of 1171, 1043 and 1029 characters as single unwrapped lines, so a wrapped continuation was
  indistinguishable from the next verb's row and the founder could not read the output at all
  ([#5208](https://github.com/kamp-us/phoenix/issues/5208)). `withShortDescription` **adds** a field
  and the renderer falls back to `description` when it is absent, so nothing is truncated and the
  contract below is untouched.
- `--help` states, for the verb: what it answers, its output **shape** (rule 2), its exit codes
  (rule 3), and at least one example (rule 5). This is the **long** description's job — the "one
  line" rule above governs the list row, not this block, and the two stop contradicting each other
  once they are separate strings.
- The index of verbs is **derived from the registry**, never hand-maintained. v1's
  `pipeline-cli commands compact` is the working precedent: it reads name + description off the same
  `Command` objects the router dispatches on, so a new verb appears automatically and a verb shipped
  without a description is mechanically detectable
  (`packages/pipeline-cli/src/tools/commands/commands.ts`).
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
- The declared shape appears in `--help` and in the [contract spec](contract-spec.md), with an example
  of the actual bytes. Prose describing a shape is not a shape.
- **The positive answer is a positive token, never an absence.** A verb whose "nothing found" answer
  is empty stdout is byte-identical to a verb that never ran. Print a state word.

### 3. The exit status is the answer; empty stdout never is

Source: [`.patterns/skill-script-io-contract.md`](../../../.patterns/skill-script-io-contract.md)'s
exit taxonomy, and the verdict-vs-invocation rule proven in v1 at
`packages/pipeline-cli/src/exit-codes.ts`
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
  | `2` | **never allocated** — the harness's block code on `PreToolUse` |
  | `126` | no implementation could be resolved — the binary was found, the verbs were not |
  | `127` | the verb never ran at all (unresolved binary) |
  | `3`+ | the verb's own proven outcomes, each enumerated in `--help` |

  `126` is the seat between the two invocation failures. `127` is the shell reporting that nothing
  ran; `1` is a verb reporting that it ran and the caller asked wrongly. Between them sits the case
  where `fabrika` itself started, could not reach a working set of verbs — an unlinked
  dependency, a repo-local install it could not execute, a cwd it refuses to answer from — and has
  something specific to say about it. Seating that on `1` would make it indistinguishable from a typo
  in a flag ([#4666](https://github.com/kamp-us/phoenix/issues/4666)). `126` is the shell's own
  *found but not executable*, which is the same claim one level up, so the two invocation failures
  read as one band.

  **`2` is allocated by nothing, in any group, and that is a hard rule rather than a free slot.** On
  a `PreToolUse` hook, exit `2` is the *one* code the harness reads as "block the tool call" — so an
  exit code seated there denies a tool call as a side effect of its status, whatever the verb meant.
  This seat used to hold "no implementation could be resolved", which made a fabrika that could not
  bootstrap block every `Task`/`Workflow` spawn in the session, the inverse of ADR
  [0250](../../../.decisions/0250-fabrika-hook-cannot-run-fails-open.md)'s ruled fail-open
  ([#5423](https://github.com/kamp-us/phoenix/issues/5423)). The full harness contract, and why it is
  `PreToolUse`-only, is in [`hook-surface.md`](hook-surface.md#the-harness-exit-code-contract). The
  rule is checked as data: `packages/fabrika-cli/src/exit-code-alignment.unit.test.ts` reds if any
  group's table allocates it.

- **The `3`+ band is scoped to the verb group that seats it. A code above the reserved band means one
  thing *within* its group and carries no cross-group uniqueness obligation.** Two shipped shapes are
  both correct, and a group picks by whether its verbs share refusal meanings:

  - **Per verb, no shared table** — the `3`+ row above read literally. Permitted, and today shipped
    nowhere: `adr` was the standing example until its five verbs seated `NO_SUBJECT` on two numbers
    and `3` on four meanings, which is what the shape costs when a group's verbs *do* share refusal
    meanings (#5294). `report dedup` was the last residue and is gone too: its two codes moved into
    the group table, and a check over every verb file now reds on the shape
    ([#5296](https://github.com/kamp-us/phoenix/issues/5296)).
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
  `review`'s `12`–`16` and `triage`'s `12`–`13` are not required to clear each other, and do not.

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
  command substitution, no `source`. The one thing that is not a `$VAR` here is a name a skill
  declares in its own `arguments:` frontmatter: the harness substitutes it into the skill body
  textually before the agent reads it, so the string the verifier checks still holds a literal
  ([skill-conventions §4](skill-conventions.md#4-the-invocation-surface-is-a-plain-literal)). That
  carve-out reaches skill bodies only — a hook command has no caller argument to bind and stays
  literal end to end.
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
([#4704](https://github.com/kamp-us/phoenix/issues/4704) / [#4724](https://github.com/kamp-us/phoenix/pull/4724));
recorded in full as [ADR 0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md).

**No fabrika skill and no fabrika verb invokes `pipeline-cli`, or anything else under
`claude-plugins/kampus-pipeline/`.** Every deterministic step a skill needs is implemented in
fabrika's own verb package. Where v1 already solved the same problem, read its source to learn the
semantics and the scars, then implement fabrika's own — duplication is the accepted cost.

The why — the deletion test, the superseded "may call but never grows into it" posture, and which v1
calls become nothing instead of verbs — is [ADR 0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md),
not re-argued here. One consequence survives as standing guidance: an authoring brief's "assumable
verbs" field is a list of **prior art to read**, never a list of things to call.

### Enforcement

There is no mechanical conformance guard yet, and that absence is deliberate: with zero fabrika verbs
in existence a repo-wide guard has zero scope and reds on itself (ADR 0092). Enforcement starts as
per-verb tests in the first verb package, which rides with the wave-0 pilot in epic
[#4650](https://github.com/kamp-us/phoenix/issues/4650). Until then this doc is what a reviewer holds
a verb to.
