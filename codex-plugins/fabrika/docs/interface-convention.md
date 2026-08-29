# fabrika CLI interface convention

The discipline every fabrika verb owes its caller: what `--help` discloses, what stdout and stderr
carry, which exit codes mean what, when a verb refuses to answer, how a verb is invoked, and what
it may call. Verb implementers build against this page and reviewers hold verbs to it.

Every rule cites the ruling or finding it came from. The *why* lives where the citation points —
an [ADR](../../../.decisions/) or the cited issue — and is not re-argued here. This page was split
from a page that also held the contract-spec format ([#7021](https://github.com/kamp-us/phoenix/issues/7021));
that second subject is now its own reference: [the contract-spec format](contract-spec-format.md).

Context, as pointers rather than paragraphs: fabrika pushes deterministic work maximally into CLI
verbs and keeps judgment in the thin skill wrapper
([#4631](https://github.com/kamp-us/phoenix/issues/4631)); an authoring session derives which verbs
its skill needs and writes the spec the CLI implements
([#4638](https://github.com/kamp-us/phoenix/issues/4638)) — that spec's format is
[contract-spec-format.md](contract-spec-format.md); the retired v1 pipeline is a frozen comparison
baseline, never a source to port from
([ADR 0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)).

Six rules follow. Each states what a verb owes its caller and cites the ruling or finding it comes
from.

## 1. `--help` is the interface — an agent discovers a verb at runtime, never by reading its source

Source: the founder given on map [#4631](https://github.com/kamp-us/phoenix/issues/4631) (runtime
discoverability is first-class), sharpened by the [#4635](https://github.com/kamp-us/phoenix/issues/4635)
survey of the v1 CLI, which found root help listing every tool with a purpose and a citation while
per-tool help documented subcommands and exit codes inline.

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

  Reusing the long form as the list row is the defect this split fixes — `fabrika ship --help` once
  emitted thousand-character unwrapped rows no reader could parse
  ([#5208](https://github.com/kamp-us/phoenix/issues/5208)). `withShortDescription` **adds** a field
  and the renderer falls back to `description` when it is absent, so nothing is truncated and the
  contract below is untouched.
- `--help` states, for the verb: what it answers, its output **shape** (rule 2), its exit codes
  (rule 3), and at least one example (rule 5). This is the **long** description's job — the "one
  line" rule above governs the list row, not this block, and the two stop contradicting each other
  once they are separate strings.
- The index of verbs is **derived from the registry**, never hand-maintained: it reads name +
  description off the same `Command` objects the router dispatches on, so a new verb appears
  automatically and a verb shipped without a description is mechanically detectable. v1's
  `pipeline-cli commands compact` was the working precedent
  (`packages/pipeline-cli/src/tools/commands/commands.ts`, deleted with v1). A parallel
  hand-written list rots; that is the defect the derived index replaced.
- **A `--help` that resolves is proof the path exists — up to the last node that takes subcommands.**
  `fabrika <unknown> …` is refused before the CLI runner sees it: the reason on stderr, nothing on
  stdout, exit `1`. That holds at the group level and inside a group, with or without `--help`, and
  however many invalid tokens follow. It has to be a fabrika-side guard because the runner answers
  the probe otherwise — `effect`'s `Command.runWith` processes action flags before it inspects parse
  errors, and `--help` is an action flag, so it printed the deepest valid prefix's help and exited
  `0` while discarding the whole invalid tail ([#4822](https://github.com/kamp-us/phoenix/issues/4822)).
- **An operand a leaf verb never declared is refused too**, at the argument layer rather than the
  path layer. Every leaf declares a hidden trailing catch-all, so the parser hands the verb whatever
  its own arguments left, and the verb refuses on stderr with exit `1` (rule 3's usage-error code)
  instead of binding none of them and answering anyway. `fabrika adr next bogus` refuses;
  `fabrika adr resolve 0164 0023` still absorbs both ids, because a variadic argument consumes its
  operands before the catch-all sees them
  ([#4828](https://github.com/kamp-us/phoenix/issues/4828)).
- **The residual caveat: a global flag placed *before* the group name ends the path guard's walk.**
  `fabrika --log-level info triage --help` exits `0` with root help even though `triage` names no
  group. The walk stops at the first `-`-prefixed token because a later bare token may be that
  flag's value (`--log-level debug`), and reading a value as a subcommand would refuse a valid
  invocation — a miss is the fail-safe direction for a guard whose only output is a refusal. This
  stays a documented residual rather than a code fix: telling a flag's value from a subcommand needs
  the parser's own per-flag arity, which the published `effect` types do not expose, so a
  fabrika-side fix would carry a hand-maintained list of which global flags take a value — the
  parallel-list rot this same rule forbids for the verb index.

## 2. Results by value on stdout; the shape is documented, not guessed

Source: the [#4635](https://github.com/kamp-us/phoenix/issues/4635) finding that the convention
existed de facto but uncodified across the v1 tools. The rule is the CLI statement of
[`.patterns/skill-script-io-contract.md`](../../../.patterns/skill-script-io-contract.md), which
binds the shell half of the same pipeline.

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

## 3. The exit status is the answer; empty stdout never is

Source: [`.patterns/skill-script-io-contract.md`](../../../.patterns/skill-script-io-contract.md)'s
exit taxonomy, and the verdict-vs-invocation separation proven in v1 at
`packages/pipeline-cli/src/exit-codes.ts` (#4208, #4219 — both since deleted with v1).

- **`0` means "I produced the answer on stdout". Any non-zero means "I could not produce one"** —
  UNKNOWN, never the permissive reading. A caller reads the status before the bytes.
- **The whole answer reaches the caller, or the verb has not answered.** A write to stdout is
  asynchronous when stdout is a pipe — and `x=$(fabrika …)` is a pipe — so `process.exit` on the line
  after the write discards whatever is still queued, silently and on exit `0`. Every group adapter
  emits through the one shared helper,
  [`emit.ts`](../../../packages/fabrika-cli/src/emit.ts), which exits from the write callback
  instead; a group that hand-rolls its own truncates its long answers again
  ([#6226](https://github.com/kamp-us/phoenix/issues/6226)).
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

  `126` is the seat between the two invocation failures: `127` is the shell reporting that nothing
  ran, `1` is a verb reporting that it ran and the caller asked wrongly, and between them sits the
  case where `fabrika` itself started but could not reach a working set of verbs — seating that on
  `1` would make it indistinguishable from a typo in a flag
  ([#4666](https://github.com/kamp-us/phoenix/issues/4666)). `126` is the shell's own *found but not
  executable*, so the two invocation failures read as one band.
- **`2` is allocated by nothing, in any group, and that is a hard rule rather than a free slot.** On
  a `PreToolUse` hook, exit `2` is the *one* code the harness reads as "block the tool call", so an
  exit code seated there denies a tool call as a side effect of its status, whatever the verb meant —
  the inverse of the fail-open polarity ADR
  [0250](../../../.decisions/0250-fabrika-hook-cannot-run-fails-open.md) rules for a hook whose verb
  cannot run ([#5423](https://github.com/kamp-us/phoenix/issues/5423)). The full harness contract,
  and why it is `PreToolUse`-only, is in [`hook-surface.md`](hook-surface.md#the-harness-exit-code-contract--exit-2-blocks-and-only-on-pretooluse).
  The rule is checked as data: `packages/fabrika-cli/src/exit-code-alignment.unit.test.ts` reds if
  any group's table allocates it.
- **The `3`+ band is scoped to the verb group that seats it. A code above the reserved band means one
  thing *within* its group and carries no cross-group uniqueness obligation.** Two shipped shapes are
  both correct, and a group picks by whether its verbs share refusal meanings:

  - **Per verb, no shared table** — the `3`+ row above read literally. Permitted; today shipped
    nowhere, which is what the shape costs when a group's verbs *do* share refusal meanings
    (#5294, [#5296](https://github.com/kamp-us/phoenix/issues/5296)).
  - **Per group, one shared table** — `report`, `triage`, `review`, `adr`, `spend` and `wire` each
    ship a `<group>/codes.ts` that every verb in the group allocates from, so a code means one thing
    across the group whichever verb produced it. That is a **tightening** a group chooses, not a
    further obligation this rule imposes.

  Neither shape reaches across a group boundary:
  [`triage/codes.ts`](../../../packages/fabrika-cli/src/triage/codes.ts) seats `12` as *the issue is
  human-filed*; [`review/codes.ts`](../../../packages/fabrika-cli/src/review/codes.ts) seats `12` as
  *the live head moved past the inspected `--sha`*. Those are two namespaces, not one collision.

- **The `report` ↔ `triage` ↔ `review` code-for-code alignment is a deliberate, bounded courtesy —
  not a repo-wide namespace.** Those three groups hold `3`, `5`, `6`, `7`, `8`, `9`, `10` and `11` on
  one meaning each, and every aligning group — the three included — *imports* the constants from
  the shared registry (`packages/fabrika-cli/src/exit-codes.ts`) rather than
  restating numerals, so a drift there is unrepresentable rather than merely detectable. The reason
  is one caller commonly driving all three in a single sweep.
  [`exit-code-alignment.ts`](../../../packages/fabrika-cli/src/exit-code-alignment.ts) mechanizes
  exactly that scope and no more: it checks each aligning group against the **base** and never
  pairwise against a sibling. Above the shared overlap each group's private band is its own —
  `review`'s `12`–`16` and `triage`'s `12`–`13` are not required to clear each other, and do not.

  [`wire/codes.ts`](../../../packages/fabrika-cli/src/wire/codes.ts) is the shipped counter-example:
  it aligns to nothing and is *registered* as unaligned with its reason, so the exemption carries
  information instead of reading as an oversight. It legitimately reuses numerals that other groups
  seat on different meanings — read its table there rather than here. Under a cross-group clearance
  rule `wire` would be the largest violation in the package; it is not a violation at all.

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

## 4. Fail closed on missing scope or state

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

## 5. Every documented invocation is a plain literal command string

Source: [#4641](https://github.com/kamp-us/phoenix/issues/4641), closed with the mechanism
understood, and [ADR 0232](../../../.decisions/0232-agents-execute-skill-scripts-never-source-them.md).

The harness's isolation verifier is a **syntactic check on the command string**: it does not consult
process env and does not touch the filesystem — `$USER` and `$PWD` are refused while genuinely set,
a symlink to a nonexistent target runs and fails with an ordinary `127`, and `$HOME` appears to be
special-cased. No env-injection mechanism
of any kind can make a variable-rooted invocation usable at an agent's top-level command.

- A fabrika verb is invoked as a plain literal command string — no `$VAR`, no `${VAR:-default}`, no
  command substitution, no `source`. The one thing that is not a `$VAR` here is a name a skill
  declares in its own `arguments:` frontmatter: the harness substitutes it into the skill body
  textually before the agent reads it, so the string the verifier checks still holds a literal
  ([skill-conventions §4](skill-conventions.md#4-the-invocation-surface-is-a-plain-literal)). That
  carve-out reaches skill bodies only — a hook command has no caller argument to bind and stays
  literal end to end.
- **The literal is `fabrika`.** Every fence in every fabrika skill writes
  `fabrika <group> <verb> …` and nothing else. The command and the package are deliberately
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
### Delivery — one name, two installs, both of them real

`fabrika` is delivered as a **global install** of `@kampus/fabrika-cli`. On startup the binary
finds the **repo root** above the working directory, asks Node's own resolver what copy that root
installed, and hands the invocation to it — the shape turbo ships, reimplemented in fabrika's own
TypeScript ([#4784](https://github.com/kamp-us/phoenix/issues/4784)). The property that buys is a
**repo-pinned version**: a repo carrying `@kampus/fabrika-cli` in its `devDependencies` gets that
version from a bare fence, whatever each machine's global happens to be.

Both installs are real installed packages, and neither is chosen by testing whether a file exists
and guessing that it will run — tiers that can be quietly wrong are the defect
([#4784](https://github.com/kamp-us/phoenix/issues/4784)).

The branch that makes that concrete is the degenerate one. **A repo root that pins the package but
has not installed it, or whose install is corrupt, runs the global and says so loudly** — naming the
global's version beside the version the root manifest declared, silenceable with
`FABRIKA_GLOBAL_WARNING_DISABLED`. It is not an error: the worst outcome is that the global runs.
**No repo root at all is the one silent branch**, deliberately, so a global-only invocation stays
quiet. Separating those two is the whole point — collapsing them is what makes a delegation quietly
wrong.

Three environment variables belong to the delivery layer rather than to any verb, and none of them
locates the binary, so none weakens rule 5: `FABRIKA_DEBUG` prints one stderr line naming which copy
served the invocation; `FABRIKA_GLOBAL_WARNING_DISABLED` silences the degenerate branch's warning;
`FABRIKA_SKIP_INFER` is the recursion guard for a caller that cannot alter argv. The guard the CLI
itself uses on the child is the **`--skip-infer` flag**, stripped before any verb sees it, and the
child is additionally handed the user's original directory as `FABRIKA_INVOCATION_DIR` because its
own cwd is set to the repo root.

## 6. fabrika calls nothing outside fabrika

Source: founder ruling, in-session 2026-08-01, on the wave-0 pilot's derived contract
([#4704](https://github.com/kamp-us/phoenix/issues/4704) / [#4724](https://github.com/kamp-us/phoenix/pull/4724)).
The why — duplication keeps v1 deletable; a call is a tether — is
[ADR 0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)'s, pointed at rather
than re-derived.

**No fabrika skill and no fabrika verb invokes `pipeline-cli`, or anything else under
`claude-plugins/kampus-pipeline/`.** Every deterministic step a skill needs is implemented in
fabrika's own verb package. Where v1 already solved the same problem, read its source at a pinned
commit to learn the semantics and the scars, then implement fabrika's own.

Two consequences, both ruled on the pilot:

- **This supersedes "fabrika may call `pipeline-cli` but never grows into it."** Wrapper verbs whose
  only job was relaying an upstream answer rebuild `pipeline-cli` by accretion — the outcome the
  superseded posture existed to prevent.
- **Not every v1 call becomes a fabrika verb; some become nothing.** Where the thing being computed
  is already *enforced* elsewhere — a CI gate, a merge check — fabrika does not compute a second
  answer to it. Ask whether the skill needs the answer, or only needs to expect it.

An authoring brief's "assumable verbs" field is therefore a list of **prior art to read**, not a
list of things to call.

## Enforcement

There is no mechanical conformance guard yet, and that absence is deliberate: a repo-wide guard
over zero verbs has zero scope and reds on itself
([ADR 0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). Enforcement lives as
per-verb tests in each verb package (first shipped with the wave-0 pilot,
[#4650](https://github.com/kamp-us/phoenix/issues/4650)), plus the data checks named above
(`exit-code-alignment.unit.test.ts`, `short-description.unit.test.ts`). Until a repo-wide guard
exists, this page is what a reviewer holds a verb to.
