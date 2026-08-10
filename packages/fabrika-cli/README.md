# @kampus/fabrika-cli

The deterministic verb package [fabrika](../../claude-plugins/fabrika/) skills call.
`fabrika <group> <verb> …` dispatches to a registered verb group. The registered groups are
`adr`, the six verbs the `/adr` skill's derived contract specifies; `report`,
the three the `/report` contract specifies; `triage`, the intake-queue group the `/triage`
contract specifies; `build`, the fourteen the `/build` contract specifies; `epic`, the
eight the `/build-epic` contract specifies; `plan`, the epic-plan gate's; `review`, the eight
the `/review` contract specifies; `review-ui`, the three the `/review-ui` contract specifies
(capture a PR's preview, emit the `review-ui` verdict, or post a typed blocker note);
`ship`, the thirteen the `/ship` contract specifies; `eval`, the graded-corpus
harness the fabrika eval layer measures itself with; `spend`, what one fabrika run cost in
tokens; `wire`, which owns the byte-level formats two skills meet through on a GitHub
artifact; `status`, the six the `/fabrika` front door's contract specifies (what state the
factory is in); and `hook`, which reads the envelope Claude Code writes to a hook's stdin — the group
[fabrika's hook surface](../../claude-plugins/fabrika/hooks.json) declares against.
`fabrika --help` lists them from the registry, so that index is never a second
hand-maintained list.

## Who it's for

fabrika's architecture is a two-layer split: deterministic work is pushed maximally into
CLI verbs, and each skill is a thin wrapper carrying only irreducible judgment. This
package is the deterministic layer. It is internal tooling for the kamp.us agent pipeline,
not a general-purpose CLI.

## It calls nothing outside fabrika

**`fabrika` invokes `pipeline-cli` nowhere** — no import, no subprocess
([ADR 0238](../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Where v1
already solves the same problem, its source is a reference for the semantics and the scars,
never a dependency.

The reason is the deletion test: a fabrika that calls v1 can never be the thing that
replaces it, because every call is a tether keeping the old tree alive. Duplication costs a
second implementation during the transition; a tether costs the ability to ever delete
anything.

## How it is delivered

`fabrika` is installed **globally**, once, and the binary decides for itself which copy runs:

```bash
pnpm add --global @kampus/fabrika-cli
```

On startup it finds the **repo root** above the working directory, asks **Node's own resolver** what
copy of `@kampus/fabrika-cli` that root has installed, and hands the invocation to it. This is the
shape [turbo](https://turborepo.com) ships (`crates/turborepo-shim/`), reimplemented here in
TypeScript ([#4784](https://github.com/kamp-us/phoenix/issues/4784)).

**No outcome is both silent and wrong**:

| Where you are | What runs | Warning |
| --- | --- | --- |
| In phoenix | the working tree — `packages/fabrika-cli` | — |
| In a consumer repo that installed it | that repo's pinned version | — |
| In a consumer repo that did **not** install it | the global | **yes**, naming both versions |
| In no repo at all | the global | no — deliberately |
| Running a **different checkout's** copy by path | nothing — it refuses, exit `2` | **yes**, naming both checkouts |

Rows three and four are the original design. Running the global outside any repo is a normal,
correct invocation, so it stays quiet. Running the global *inside a repo that asked for a specific
version* is the quietly-wrong case, so it says so out loud and names the global's version beside the
one the root manifest declared. Set `FABRIKA_GLOBAL_WARNING_DISABLED=1` to silence it.

The last row closes the one case that used to be quietly wrong ([#4956](https://github.com/kamp-us/phoenix/issues/4956)).
`node <other-checkout>/packages/fabrika-cli/src/bin.ts` run from a cwd inside *this* checkout looked
exactly like a global install on `PATH`, so it delegated — and answered from the checkout you did
not name, with no warning at all. It is a live hazard for anyone reviewing from a worktree: the CLI
reports the state of `main` while you are reading a branch. The two are separated by asking which
checkout the *invoked copy* belongs to; an installed copy (anything under `node_modules`) belongs to
none, which is what keeps the global-install delegation exactly as it was. Either run it from inside
its own checkout, or pass `--skip-infer` to make the copy you named serve the invocation.

The property this buys is a **repo-pinned version**. phoenix carries `@kampus/fabrika-cli` in its
root `devDependencies`, so a bare `fabrika` anywhere in a phoenix checkout runs the version this
repo pins — and because pnpm links the workspace package, that means the **working tree**: edit
`src/`, the next invocation runs the edit. This supersedes `pnpm link --global`, which is
machine-wide and has to be remembered and undone.

`FABRIKA_DEBUG=1` prints one stderr line naming which copy served the invocation:

```
$ FABRIKA_DEBUG=1 fabrika --version
fabrika: global at …/pnpm/global/5/…/@kampus/fabrika-cli — delegating to the repo-local install at …/packages/fabrika-cli (…/src/bin.ts, v0.1.0)
fabrika v0.1.0
```

**Two independent recursion guards**, both read before any filesystem work: the parent always passes
`--skip-infer` to the child (stripped before any verb sees it), and `FABRIKA_SKIP_INFER` does the
same for a caller that cannot alter argv. turbo needs both because a missed guard would re-enter the
shim; we need them *more*, because for us the global and the local are the same JS file shape.

The child's cwd is the **repo root**, not yours; your cwd travels as `FABRIKA_INVOCATION_DIR`. That
is deliberate — an older local binary cannot choke on an env var it never reads, whereas it would
refuse an unknown flag.

> [!IMPORTANT]
> **`@kampus/fabrika-cli` is not published yet, so the install above does not work today.** It
> answers a registry 404 (`npm error code E404`, exit `1`, nothing on stdout). Publishing needs npm
> Trusted Publishing registered against this repo plus a one-time bootstrap publish — a human action
> outside the repo, tracked by [#4791](https://github.com/kamp-us/phoenix/issues/4791). Until it
> lands, a bare `fabrika` exits `127` on a machine with no global install, which the interface
> convention reserves for exactly that: the verb never ran. Inside a phoenix checkout the fallback
> is `node packages/fabrika-cli/src/bin.ts …`.

> [!NOTE]
> **The published artifact is compiled; the development loop is not.** Node refuses to strip types
> for any file whose resolved path is under `node_modules` — `stripTypeScriptModuleTypes` throws
> `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` unconditionally on `isUnderNodeModules(filename)`
> (read from Node 24.4.1 and 26.2.0's own bundled source) — so a `.ts` `bin` cannot start from an
> installed copy, which is what a real `pnpm add --global` produces. `publishConfig` is what lets
> both halves be true at once: the manifest's `bin` stays `./src/bin.ts` for the workspace, where
> pnpm's link resolves *outside* `node_modules` and an edit to `src/` is live on the next
> invocation, and npm rewrites `bin`/`main`/`types`/`exports` onto the compiled `dist/` at publish
> time. `files` is `["dist"]` and `prepublishOnly` runs the build, so a tarball can neither miss
> `dist/` nor ship a stale one (#4784).

## Quickstart

```bash
# list the registered verb groups
node src/bin.ts --help

# one group's verbs, flags and exit codes
node src/bin.ts adr --help

# run a verb
node src/bin.ts adr next
```

The `--help` index is derived from [`src/registry.ts`](./src/registry.ts) — a group appears
by being registered and nowhere else, so a parallel hand-written list cannot drift out of
step with what actually dispatches.

## The interface every verb meets

Governed by
[`claude-plugins/fabrika/docs/cli-interface-convention.md`](../../claude-plugins/fabrika/docs/cli-interface-convention.md).
Four rules matter most to a caller:

- **Stdout is the answer; everything else is stderr.** Scope lines, refusal reasons and
  progress are diagnostics.
- **The positive answer is a positive token, never an absence.** `adr sweep` prints
  `no-overlap`, not an empty shortlist — a verb whose "nothing found" answer is empty
  stdout is byte-identical to a verb that never ran.
- **The exit status is the answer; empty stdout never is.** `0` = the answer is on stdout,
  `1` = usage error or the verb failed to run, `2` = the binary started but could not resolve an
  implementation, `127` = the verb never ran, `3`+ = the verb's own proven outcomes. **A non-zero
  exit is UNKNOWN** — read the status before the bytes.
- **Fail closed on missing scope or state.** A zero-record scan is a failed read, not an
  answer ([ADR 0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)); an
  unreadable input resolves to a refusal, never to a permissive default.

## The `adr` group

The contract these six implement is
[`claude-plugins/fabrika/skills/adr/contract.md`](../../claude-plugins/fabrika/skills/adr/contract.md).

| Verb | Answers |
|---|---|
| `adr next` | the next unused id — `max(fetched merged set ∪ open-PR claims) + 1` |
| `adr new` | scaffolds `.decisions/NNNN-slug.md` from the canonical template |
| `adr resolve` | each id's real filename and state: `live` / `landed` / `in-flight` / `absent` |
| `adr supersede` | rewrites an older record's `status:` line to `superseded by [NNNN](…)` |
| `adr amend-in-part` | appends this id to an older record's `amended-in-part by` list |
| `adr sweep` | ranks the uncited live-accepted records this one may contradict |

Three behaviours are worth knowing before you call them:

- **`--base` is fetched before it is read.** Reading a stale local ref is the defect class
  the contract exists to close — it is how two lanes both minted ADR 0198, and how a stale
  checkout applied a withdrawn ADR 86 minutes after the withdrawal landed.
- **`live` and `landed` are different answers.** `landed` means present on the base ref but
  `proposed`, `superseded` or `retired`; 36 of the 233 records on `main` are in that state,
  and citing one as settled law is the failure this split exists to prevent.
- **`supersede` / `amend-in-part` assert a one-line diff before writing.** An accepted ADR's
  decision text is immutable, so a rewrite that would touch any line but `status:` aborts
  with exit 6 and writes nothing.

## The `report` group

The contract these three implement is
[`claude-plugins/fabrika/skills/report/contract.md`](../../claude-plugins/fabrika/skills/report/contract.md).

| Verb | Answers |
|---|---|
| `report dedup` | ranks the open issues that may already cover an observation — `candidates` / `none` / `indeterminate`, all three at exit 0 |
| `report file` | composes the intake issue from the six sections on stdin, guards it, creates it, and reads back what landed |
| `report note` | adds a note to an existing issue over the same guarded path, and reads the comment back |

Four behaviours are worth knowing before you call them:

- **The body is a value, never a path.** The two writing verbs take it on **stdin only** —
  no `--body`, no `--body-file`, no temp file. A flag that accepts a path turns the body
  into a string the verb could post verbatim, which is exactly how a machine-local path
  reached a public artifact while the poster read success. A shell redirect is fine: the
  *shell* reads the file, so what reaches the verb is already the bytes.
- **An empty stdin is a refusal, not an empty body.** A read that failed exits `1` (the body
  is UNKNOWN) and a pipe that was read and held nothing exits `3` (a proven refusal). They
  are never the same answer.
- **A missing `--label` is a refusal on `dedup` too, not a `none`.** `GET /issues?labels=…`
  answers HTTP 200 with `[]` for a label that does not exist, so an unchecked `dedup` would
  print a proven negative over a scope of zero — the fail-open ADR 0092 forbids. Both
  writing and reading verbs check the label first and exit `7` when it is absent
  ([#4752](https://github.com/kamp-us/phoenix/issues/4752)).
- **The write is not finished until it is read back.** A create call's own response is the
  server echoing the request; exit `9` is the landed artifact failing to match what was
  composed.

Intake applies **no type and no priority**, and that is defended mechanically rather than in
prose: exit `10` refuses a `--label` or a title prefix that resolves to the target repo's own
type/priority vocabulary.

## The `triage` group

The contract is
[`claude-plugins/fabrika/skills/triage/contract.md`](../../claude-plugins/fabrika/skills/triage/contract.md).
**Only the shared substrate is built so far** — the group's nine verbs (`queue`, `claim`,
`provenance`, `homes`, `split`, `enrich`, `apply`, `park`, `kill`) land in later slices of
[#4831](https://github.com/kamp-us/phoenix/issues/4831), and the one registered verb today
prints the table they will all allocate from.

| Verb | Answers |
|---|---|
| `triage codes` | the exit taxonomy every verb in the group allocates from, one `<code>\t<meaning>` line per code |

Three properties of that substrate are worth knowing before the verbs arrive:

- **All nine verbs allocate from one table** ([`src/triage/codes.ts`](./src/triage/codes.ts)),
  so a code means one thing across this group. Where it overlaps the two `report` writing
  verbs — `3`, `5`, `6`, `7`, `8`, `9`, `10`, `11` — the meanings match **code for code**, so
  a caller driving both groups in one sweep reads one meaning. That alignment does not extend
  repo-wide: `adr` allocates per verb, and `report dedup`'s own `3`/`4` mean something else
  again.
- **`4` is a deliberate gap.** It once fused "the target issue is proven absent" with "the
  target issue could not be read". `7` and `11` took the halves, and the slot is left
  unallocated rather than compacted — a gap is cheaper than a collision, and it keeps the
  alignment with `report file`, where `4` is a body-section failure no verb here performs.
- **Every list read pages and reports its scanned count** on stderr
  ([`src/triage/scope.ts`](./src/triage/scope.ts)). A verdict driven by a silently truncated
  read is a verdict over unknown scope; pagination fixes the reach, and printing what was
  scanned is what makes the reach checkable from outside the process.

## The `review` group

Everything a text review needs off one pull request, plus the one sanctioned way to write a
verdict back. The group implements
[`claude-plugins/fabrika/skills/review/contract.md`](../../claude-plugins/fabrika/skills/review/contract.md).

| Verb | What it answers |
|---|---|
| `review scope` | head SHA, linked issue, the code / doc / skill partition of the changed files, and the `self` / `harness` flags — the list read at the printed commit, never beside it |
| `review diff` | the diff bytes at the bound commit, with truncation refused rather than passed through |
| `review criteria` | the linked issue's acceptance-criteria block, through the registered wire format |
| `review ci` | the live check-run rollup at a head, fail-closed on incomplete enumeration |
| `review verdicts` | every verdict marker on the PR, each with its `current` / `stale` / `unbindable` binding |
| `review deviations` | the PR body's `## Deviations` state, its entries, and the Tier-M token scan over the diff at the bound commit |
| `review post` | the single sanctioned verdict emit — compose, bind, one comment per namespace, read back |
| `review append-criterion` | one reviewer-authored criterion appended under ADR 0079's four fences |

- **A check that cannot see what it is looking for does not return a plausible value.** An
  unreadable response, a provably short read and a non-conforming payload each resolve to
  their own loud refusal — `11`, `13` and `7` — and never to a clean pass. That is the whole
  reason `13` exists beside the other two ([`src/review/codes.ts`](./src/review/codes.ts)).
- **The overlapping exit codes are imported, not restated** — `3`, `5`, `6`, `7`, `8`, `9`,
  `10` and `11` come from `../report/codes.ts` and `../triage/codes.ts` by re-export, so they
  cannot drift from the shipped values.
- **`current` / `stale` / `unbindable` stay three outcomes.** `review verdicts` is the first
  consumer of [`verdict-marker.ts`](./src/wire/verdict-marker.ts)'s `bindToHead`, and folding
  any two of them together is how a stale PASS reads as a current one.
- **Four modules are imported rather than re-derived**: the AC parser, the verdict-marker
  parser, `normalizeForReadback`, and the machine-local-path predicate.
- **Every guard is demonstrated failing.**
  [`src/review/mutation.unit.test.ts`](./src/review/mutation.unit.test.ts) plants a
  counterexample per guard, breaks exactly that guard, and asserts the verb returns the
  specific wrong answer instead — a guard that cannot be shown failing is not demonstrated.

## The `ship` group

Everything the merge path needs off one pull request, plus the four writes that arm, watch,
disarm and record it. The group implements
[`claude-plugins/fabrika/skills/ship/contract.md`](../../claude-plugins/fabrika/skills/ship/contract.md).

| Verb | What it answers |
|---|---|
| `ship scope` | head, lifecycle state, linked issue, artifact classes with their required namespaces, and the four-state §CP classification |
| `ship cp-approval` | the ADR 0175 cardinality discharge — `discharge` / `stop` / `n/a`, from head-bound signals only |
| `ship gate` | the verdict conjunction over every required namespace, advisory and native-review fold included |
| `ship checks` | the head CI rollup, with the running-vs-wedged split and the zero-checkset facts |
| `ship evidence` | the SHA-bound run-evidence bundle as `present` / `pending` / `absent` / `unknown` |
| `ship threads` | every unresolved review thread, both pagination layers count-proved, with its class facts |
| `ship resolve` | the sanctioned thread-resolution write, refusing any thread not positively bot-classed |
| `ship enqueue` | the queue arm at a pinned head, method-flag-free by construction, proven landed |
| `ship reconcile` | the bounded post-enqueue watch — `landed` / `ejected` / `unresolved` / `parked` |
| `ship disarm` | the four-site merge-intent lifecycle (ADR 0198), read-back-verified |
| `ship nudge` | the at-most-once dropped-trigger remedy, precondition re-derived here |
| `ship note` | the durable stop-path comment, leak-scanned and read back |
| `ship release` | dark-ship detection and the `status:awaiting-release` label |

- **The §CP boundary is derived from `.github/CODEOWNERS` itself**, read at the base branch,
  so this group and the merge gate read one artifact and cannot disagree. A *trivial* boundary
  — no team-owned rows, or a row that covers everything — is a printed hold, never a
  match-everything verdict; an *unreadable* one is `11` ([`src/ship/codeowners.ts`](./src/ship/codeowners.ts)).
- **Three modules are extended rather than forked**: the class map and the check-run rollup
  are the `review` group's own ([`src/review/classes.ts`](./src/review/classes.ts),
  [`src/review/rollup.ts`](./src/review/rollup.ts)), and `normalizeForReadback` and the leak
  predicate come from `report`. Ship and review cannot disagree about what a file is.
- **`16` and `17` are this group's own proven refusals.** `16` is the write-side state guard —
  the verb re-derives its own precondition and declines without touching the PR. `17` says the
  nudge's close landed and its reopen is unconfirmed, a state so much worse than a failed write
  that folding it into `8` would hide the one fact an operator must act on now.
- **Exactly two verbs use GraphQL** (`threads`, `resolve`), because review-thread resolution
  state has no REST equivalent. Every other verb is `gh api` REST, paginated, with the
  platform's declared count carried beside what arrived.

## The `epic` group

The epic conductor: one epic run, driven to a single PR. The group implements
[`claude-plugins/fabrika/skills/build-epic/contract.md`](../../claude-plugins/fabrika/skills/build-epic/contract.md).
Lane mechanics are **not** here — the conductor claims, branches, validates, pushes, opens the PR
and posts progress with the landed `build` verbs; this group adds only what a conductor has and a
lane verb does not.

| Verb | What it answers |
|---|---|
| `epic open` | the run: the slices parsed off the epic's planned ledger, resolved and ordered, with the nonce-keyed ledger created or resumed |
| `epic next` | exactly one next action, folded from the ledger and the git graph, retry breakers enforced |
| `epic record` | one closed-vocabulary event, appended and read back, with HEAD self-captured |
| `epic brief` | one slice's dispatch brief, through the registered `slice-handoff` wire format |
| `epic landed` | whether a slice's commit landed, proven from the graph alone |
| `epic slice-diff` | the unpushed commit's diff bytes, served from the local object store |
| `epic verdict` | one slice verdict, bound to the commit SHA in the local graph |
| `epic status` | the whole run folded — per-slice state, verdict bindings, both counters |

- **The run is worktree-resident and keyed on the claim nonce, never the session id.** Sibling
  subagents of one conductor share a session id, so a session-keyed run file is a write collision
  the victim cannot see. `epic open` also registers the run directory in the tree's git exclude, so
  conductor state cannot enter the epic's PR ([`src/epic/ledger.ts`](./src/epic/ledger.ts)).
- **A ledger that reads and cannot be named is `21`, not a guess.** An off-enum event, a broken
  line or a `seq` regression refuses and names itself; a ledger that could not be *read* is `11`,
  and a provably absent one is `20` whose repair is `epic open`. No message here is worded "does
  not exist, or is not readable".
- **Two counters per slice, never summed** — the fail axis counts the FAIL that opens a retry
  cycle, the dead axis counts dead dispatches, each capped at 2 (ADR 0130). A crashed dispatch and
  a failing implementation are different problems, and a shared counter hides whichever is rarer.
- **`epic landed` reads the graph, never the report.** HEAD moved, the old tip is an ancestor, the
  tree is clean, the commit is non-empty. Its `22` is positive evidence that a returned subagent
  produced nothing — the conductor-side detector for the silent-green class
  ([`src/eval/spawn.ts`](./src/eval/spawn.ts)).
- **A slice verdict binds a commit SHA, not a pushed head.** The whole point of the unpushed-slice
  loop: a SHA is content-addressed, so an amend or rebase makes the old verdict `unbindable`
  against the new graph rather than quietly stale, and `status` re-derives every binding against
  the live graph on each read.

## The `wire` group

A **wire format** is the byte-level agreement two skills meet through on a GitHub artifact —
the acceptance-criteria block on a sub-issue body, the verdict marker on a PR, the
slice-handoff brief an epic conductor hands one implementer. Each one is
owned by a typed schema module under [`src/wire/`](./src/wire/) with an `emit` and a
`read`, registered as one row in [`src/wire/registry.ts`](./src/wire/registry.ts). The
formats used to live as prose in a skill body, which is why fabrika could not pin one: the
`### Acceptance criteria` heading was named in no code at all.

| Verb | Answers |
|---|---|
| `wire formats` | the registered formats, derived from the registry — key, purpose, producers, consumers |
| `wire codes` | the exit taxonomy every verb in the group allocates from |
| `wire emit` | the format's bytes, composed from the fields on stdin |
| `wire read` | the format's fields, read out of the artifact on stdin |
| `wire check` | whether the artifact on stdin carries a conforming block, without the fields |
| `wire index` | whether the index doc agrees with the registry — and, with `--write`, the doc's generated table, rendered from it |

Three properties are worth knowing before you call them:

- **`read` is total, and `found` is its only answer.** The return type is
  `Found | Absent | Malformed` and nothing else, with `Found` carrying a non-empty list by
  construction. A heading that drifted — a different spelling, a different level, a section
  with no checkbox items — is `Malformed`, never a `Found` holding nothing. That is the whole
  point: the prose-owned era's failure was not a crash, it was a *plausible* empty answer, and
  a grader reading it passed over nothing without an error.
- **Absent, malformed and never-seen are three different exit codes.** `3` is a proven
  negative over an artifact that was read in full; `4` is a proven defect; `6` means fd 0
  carried nothing readable, so nothing is proven at all. Fusing any pair is what lets an
  unread artifact pass for a clean one.
- **The artifact arrives on stdin only.** No `--body`, no `--body-file` — the same reason the
  `report` and `triage` writing verbs take theirs there: a flag that accepts a path turns the
  artifact into a string the verb could echo back onto a public surface.
- **A `found` verdict marker is well-formed, not current.** `verdict-marker` carries the head
  SHA the reviewer inspected, and a marker bound to a head that has since moved is *stale*, not
  passing. Whether a marker binds the head you hold is
  [`verdict-marker.ts`](./src/wire/verdict-marker.ts)'s `bindToHead` — three answers again
  (`Current` / `Stale` / `Unbindable`), because a head the caller could not resolve is not a
  comparison anyone made.
- **`slice-handoff`'s read side refuses instructions it does not own.** Its four sections are
  closed and its `## Rules` text is byte-fixed, so a brief carrying an extra heading, an edited
  rule, or a sentence outside every section reads `Malformed` rather than `Found` — coordination
  output that cannot steer its receiver past the artifact
  ([`slice-handoff.ts`](./src/wire/slice-handoff.ts)).
- **The index doc's per-format table is generated, not typed.** `claude-plugins/fabrika/docs/wire-formats.md`
  used to carry a hand-copied projection of each row's owner module, producers and consumers, which
  is a second source of truth that agrees until someone lands a format and forgets a line. The table
  is now rendered from the registry by `wire index --write` and reconciled by `wire index`, which
  reds on a registered format with no section, a section for no registered format, and a stale
  region ([`index-doc.ts`](./src/wire/index-doc.ts), #4968). The protocol narrative under each
  heading stays hand-written — it is the half no row holds.
- **A registered format is a conforming format.** A registry row carries the fixtures its laws
  are driven from and the brands its value is built from, and both are required by the row
  type — so adding a format means filling them in, and
  [`conformance.ts`](./src/wire/conformance.ts) then holds it to the same laws as every other
  row without naming it. Weakening one of those brands to a bare `string` stops the *row* from
  compiling, which is how the type-level half is inherited rather than re-written per format.

```bash
printf 'the read is total\n[x] the registry is the seam\n' \
  | node src/bin.ts wire emit --format acceptance-criteria \
  | node src/bin.ts wire check --format acceptance-criteria
```

## The `eval` group

The eval harness, moved here from v1 by founder ruling
([#4777](https://github.com/kamp-us/phoenix/issues/4777)) so that "the existing report and
scorecard path" the eval-layer children are specced against is a fabrika path rather than a
call into `pipeline-cli` that ADR 0238 forbids. Its own docs are
[`src/eval/README.md`](./src/eval/README.md).

| Verb | Answers |
|---|---|
| `eval check` | whether a corpus manifest matches the schema |
| `eval report` | the graded two-axis scorecard (pass-rate × net-token cost) over runner rows |
| `eval cases` | whether an authored eval set decodes, and the tier each case derives to |
| `eval run` | executes an eval set unattended on both arms and emits the capture manifest |

`eval run` is the one verb that spawns a model. Its supported callers are an operator's
shell and a `review-skill` spawn — **never a CI job**, on the cost constraint the founder
ruled on epic #4649, which `src/eval/spawn.unit.test.ts` asserts rather than states.

The token meter these verbs price runs with is fabrika's own
([`src/spend/token-spend.ts`](./src/spend/token-spend.ts)), not v1's. `billed` is
*specified* by ADR 0112 §2, not chosen, so the two implementations are held to one ruler by
a committed transcript fixture both packages' unit tiers assert against —
`src/spend/fixtures/one-ruler/`.

## The `hook` group

The envelope Claude Code writes to a hook's stdin, read once here instead of in every hook.
This is the group [fabrika's hook surface](../../claude-plugins/fabrika/hooks.json) declares
against ([#5074](https://github.com/kamp-us/phoenix/issues/5074)); the surface's convention and
its one interim dispatch-failure policy point live in
[`claude-plugins/fabrika/docs/hook-surface.md`](../../claude-plugins/fabrika/docs/hook-surface.md).

| Verb | Answers |
|---|---|
| `hook check` | whether the envelope on stdin is one fabrika can act on — `conforms\t<hook_event_name>\t<field-count>` |
| `hook codes` | the exit taxonomy every verb in the group allocates from |
| `hook spawn` | whether the subagent spawn on stdin may run on the model it asked for — the `PreToolUse` permission decision, denying an off-allowlist model |

Three things shape it:

- **Three failures, three codes.** "Stdin held nothing" (`3`), "bytes arrived and are provably
  not an envelope" (`12`) and "fd 0 could not be read" (`13`) are different claims, and fusing
  any two lets an unread pipe pass for a bad payload (ADR 0092).
- **The required fields are captured, not assumed.** They are the keys present in both real
  envelopes committed at `src/hook/__fixtures__/`, with their capture method and harness version
  beside them (ADR 0180). The golden test runs the argv it reads out of the committed
  `hooks.json`, so a green test cannot be exercising a verb the surface does not declare.
- **`hook spawn` is a decision, wrapped thinly.** The allow / allow-inherit / deny outcome is a pure
  function of `(requested model, WORKFLOW_MODEL pin)` in [`src/hook/spawn.ts`](./src/hook/spawn.ts),
  over the one model vocabulary in [`src/models.ts`](./src/models.ts) — the allowlist, the harness
  alias map and the committed default pin, which are one table because the request is canonicalized
  through the aliases *before* the allowlist sees it.

## The `spend` group

What one fabrika run cost, in tokens, read from its transcript. The group is the CLI surface
over the meter the `eval` verbs already price runs with — it adds no second sum
([#5007](https://github.com/kamp-us/phoenix/issues/5007), epic
[#4779](https://github.com/kamp-us/phoenix/issues/4779)).

| Verb | Answers |
|---|---|
| `spend read` | one run's billed token spend, its four `usage` components, the ex-cache-read comparator, its billed turn count and its model |
| `spend rollup` | what **all** of fabrika's recorded runs cost, summed out of the durable ledger and broken down by day, by skill and by stage-and-arm |

Three behaviours are worth knowing before you call it:

- **The cache-read share stays its own number.** It dominates `billed` and grows with turn
  count, which makes it the context-bloat signal; folding it into one total is what hides the
  thing the measurement exists to show.
- **"I could not measure it" is never a zero.** Exit `3` is a transcript that is provably not
  there, `4` is one that could not be read (or whose absence could not be established — the
  spend is UNKNOWN), and `5` is a transcript read in full that carries zero billed assistant
  turns. That third state is a real transcript a failed run writes, and reporting it as a
  measured zero would price a broken run as a free one.
- **It cannot block anything.** No threshold, no budget flag, and no exit code that varies
  with a spend magnitude — the no-gate ruling on epic #4779, asserted by a test that a
  very large total still exits `0` rather than left as a note here.

### The spend ledger

`spend read` prices one transcript on demand; the ledger is where measured runs *survive*
([#5009](https://github.com/kamp-us/phoenix/issues/5009)). `fabrika eval run` appends one
**JSON Lines** row per completed run to `.fabrika/spend-ledger.jsonl` (repo-relative,
gitignored, `--spend-ledger` overrides it) once the suite finishes — each line carrying that
run's spend and the identity of the work it measured. The core is
[`src/spend/ledger.ts`](./src/spend/ledger.ts): `appendSpendLedger` writes, `readSpendLedger`
reads back the well-formed rows **and the count of lines it skipped**, so a truncated tail
costs one line rather than the file. Every line stamps its own `v`, which is the seam a later
row shape evolves through.

The module imports from `spend/` and `io/` only — never `eval/` — so a reader of the ledger
does not drag in the eval harness that writes it.

### `spend rollup` — the epic's acceptance test, as one command

```bash
fabrika spend rollup                                    # everything recorded so far
fabrika spend rollup --since 2026-08-01 --until 2026-08-09
fabrika spend rollup --json
```

This is the one output epic [#4779](https://github.com/kamp-us/phoenix/issues/4779) exists to
produce ([#5010](https://github.com/kamp-us/phoenix/issues/5010)): a number a human or an agent
reads on demand. It reads persisted rows only — it spawns nothing, re-parses no transcript, and
slows no lane. `--ledger` points it at a ledger other than the default; `--since`/`--until` are
**inclusive at both edges**, and a bare `YYYY-MM-DD` widens to that whole UTC day, so
`--until 2026-08-09` means "through the 9th" rather than "up to its midnight".

stdout is one record per line, the first field naming the kind:

```
billed        <n>          exCacheRead <n>   assistantTurns <n>
runs          <n>          measuredRuns <n>
skipped       <n>          skippedMalformed <n>   skippedNewerVersion <n>
undatedRows   <n>
day        <YYYY-MM-DD>        <billed> <exCacheRead> <assistantTurns> <runs> <measuredRuns>
skill      <name>              …
stage-arm  <stage> <arm>       …
```

Four things about it are load-bearing:

- **Every number it could not count is a number it reports.** The unread-line counts ride on the
  answer itself (and in `--json`), not just on stderr, because a total that quietly omits 40
  unreadable lines is worse than an error — it is wrong and looks whole. `undatedRows` is the same
  rule for a bounded window: a row whose timestamp does not parse cannot be *proven* inside the
  window, so it is excluded and counted rather than silently kept or dropped.
- **The skipped count is split, because the two halves ask for opposite things.**
  `skippedMalformed` is damage — those measurements are gone. `skippedNewerVersion` is intact data
  written by a newer row shape: the rows are still there and the fix is to upgrade this CLI.
  Reporting both as one "40 lines lost" is a false alarm in one direction and a missed data loss in
  the other.
- **Four refusals, none of them a zero.** `3` is no ledger at that path (nothing recorded yet), `4`
  is a ledger that could not be read (the spend is UNKNOWN), `5` is one read in full that yielded no
  rows at all, and `6` is a ledger that *does* hold rows where the given window selects none — an
  empty window is a different fact from an empty ledger, so it gets its own code. Each refuses with
  empty stdout.
- **It cannot gate.** No threshold flag, no budget option, and no exit code that varies with the
  size of a total — the no-gate ruling on epic #4779, asserted by a test that an arbitrarily large
  total still exits `0`.

The core is [`src/spend/rollup.ts`](./src/spend/rollup.ts), pure and total: it sums a
`readSpendLedger` result over a resolved window and groups it three ways.
[`src/spend/rollup-verb.ts`](./src/spend/rollup-verb.ts) is the IO around it.

## The `status` group

What state the factory is in — the six verbs
[`front-door`](../../claude-plugins/fabrika/skills/front-door/SKILL.md) drives
([#5214](https://github.com/kamp-us/phoenix/issues/5214), spec:
[`contract.md`](../../claude-plugins/fabrika/skills/front-door/contract.md)).

```
status open                       # the composite four-field readout the skill injects
status config                     # which declared repo surfaces exist here — the detection verb
status menu                       # the landed skill roster, derived from the skills tree
status readout                    # the landed-decision digest, as published
status board                      # counts of the board's decided buckets
status bootstrap readout-artifact # create one missing surface, then read it back
```

Three things about it are load-bearing:

- **The three-state law.** Every field, row and bucket is a live value, a **proven negative**
  (`empty` / `absent` / `missing` / `unprobeable` / `malformed`), or **`unknown`** with its reason —
  and the third never renders as the second. An absent label is `unknown`, never `0`; an
  unregistered decoder is `unknown`, never `absent`.
- **`status open` is total.** It is injected before a session reads a token, and
  [`src/verb.ts`](./src/verb.ts)'s `refuse()` hardcodes empty stdout — so a refusal would leave the
  front door silent on exactly the cold start it exists for. Every source it cannot read becomes a
  field state; its one refusal seat is a bad `--field`. It composes by **importing** the sibling
  cores, never by spawning a verb and reading its exit code.
- **`7` and `11` are the pair.** `7` is an **explicitly passed** `--skills-dir` proven absent; `11`
  is a failed read. An *implicitly* resolved roster holding zero skills is neither — it is `empty`
  at exit `0`.

The roster resolves in three tiers — an explicit `--skills-dir`, the installed plugin's own skills
tree, then `claude-plugins/fabrika/skills` in-repo — and prints which one served
([`src/status/roster.ts`](./src/status/roster.ts)).

## The `ui` group

What the visual modality adds to a construction lane — the verbs
[`build-ui`](../../claude-plugins/fabrika/skills/build-ui/SKILL.md) drives
([#5061](https://github.com/kamp-us/phoenix/issues/5061), spec:
[`contract.md`](../../claude-plugins/fabrika/skills/build-ui/contract.md)). The lane mechanics are
the `build` group's, reused as-is; this group is only what rendering adds.

```
ui manifest                                   # the repo's design surfaces, by convention
ui law                                        # the typed prohibition registry, schema-validated
ui render --out after --surface /pano         # render + capture one validated PNG per surface
ui golden --surface /pano [--candidate <png>]  # resolve the blessed golden, diff a candidate
ui evidence --pr 4318 --before before --after after   # upload, verify, post, read back
```

Four things about it are load-bearing:

- **A verb's ceiling is the golden diff.** No `ui` verb emits a PASS/FAIL token, a composition
  score, or any judgement over pixels — the rendered-surface verdict is `review-ui`'s gate
  ([#4718](https://github.com/kamp-us/phoenix/issues/4718)), and everything that *looks* at an image
  is the skill's, not a verb's (founder ruling, 2026-08-09). `ui golden` measures; it never decides.
- **Everything the group reads is a convention path in the repo it runs in** —
  `design-system-manifest.md`, `design-prohibitions.json`, `design-harness.json`,
  `packages/design-capture/golden-pointer.json` — never a hardcoded URL. That is what makes the
  group portable: phoenix is one instance of a repo it reads, not the repo it knows.
- **The headless browser is provisioned by installing the package.** `postinstall` runs
  [`scripts/provision-browser.mjs`](./scripts/provision-browser.mjs), so no operator and no agent
  ever runs a browser-install step by hand. It is best-effort and never fails the install; it skips
  when the browser is already there, when `PLAYWRIGHT_BROWSERS_PATH` names a managed install, when
  `CI` is set (CI images bake their own), or on `FABRIKA_SKIP_BROWSER_PROVISION=1`. A run that then
  finds no browser exits `11` **carrying the exact remediation command** — never a silent skip.
- **Absence is answered three ways, never one.** A missing manifest is `12` (un-bootstrapped, route
  to front-door), a missing registry is `13` (the law is untyped, prose is the source), and an
  unreadable one is `11` (UNKNOWN) — the skill's prose fallback is legal only in the middle case.
  The same split runs through `ui golden`: a pointer that could not be read is never an empty
  blessed set ([#4501](https://github.com/kamp-us/phoenix/issues/4501)).

`ui render` and `ui evidence` both guard the lane precondition (`18` proven-not-mine, `11`
unreadable); `ui manifest`, `ui law` and `ui golden` are pure reads and take none. Evidence is
all-or-nothing: one failed upload or upload-verification is `17` with **nothing posted**
([#3925](https://github.com/kamp-us/phoenix/issues/3925)).

## The capture machinery

Not a verb group — a **library subpath**, `@kampus/fabrika-cli/capture`. It is the
screenshot / render / golden-diff machinery `build-ui` and `review-ui` drive: shoot a
surface over a preview or a local build, store and resolve a blessed golden, and diff
rendered-vs-golden. Its own docs are [`src/capture/README.md`](./src/capture/README.md).

```ts
import {captureAndUpload, diffRasters, loadGoldenPointer} from "@kampus/fabrika-cli/capture";
```

It moved here from phoenix's `packages/design-capture` by founder ruling
([#5063](https://github.com/kamp-us/phoenix/issues/5063)), so an adopter gets it with
fabrika rather than through a second release train. **The repo-specific data did not move**:
golden bytes stay in depo and the pointer naming them stays in the consuming repo
([ADR 0183](../../.decisions/0183-golden-screen-storage-depo-git-pointer.md)) — this package
ships the machine, never a repo's goldens.

Three consequences worth knowing before you install it:

- **`@playwright/test` is a hard dependency**, inherited from the machinery, so a fabrika
  install pulls it in even for a caller that never captures. The browser binary rides the
  install too — see [the `ui` group](#the-ui-group)'s provisioning note — and a run on a machine
  where that did not complete fails loudly, with the remediation command, rather than silently.
- **Storing golden bytes is an injected `StoreLeg`, not a dependency.** A repo's goldens live
  in its own asset store, so anything naming a host or a credential stayed with the consuming
  repo — phoenix keeps that half in `packages/design-capture/`. This package owns the shape and
  the diff, never the store. It is also what keeps the package installable: a published artifact
  may depend only on what a clean registry resolves
  ([ADR 0201](../../.decisions/0201-pipeline-tenant-phoenix-first.md) §3), and phoenix's depo client is
  private.
- **The capture bin is still phoenix's** — `node packages/design-capture/src/bin.ts capture …`,
  unchanged. It is a v1 caller, not the adopter-facing surface; the adopter-facing surface is the
  `ui` verb group ([#5061](https://github.com/kamp-us/phoenix/issues/5061)) — see
  [the `ui` group](#the-ui-group). This move deliberately changed no behavior.

## Development

```bash
pnpm --filter @kampus/fabrika-cli test        # vitest
pnpm --filter @kampus/fabrika-cli typecheck   # tsgo
pnpm --filter @kampus/fabrika-cli build       # tsc -> dist/, for the published tarball only
```

**The development loop has no build step.** `bin` points at `./src/bin.ts` and Node ≥ 24 strips the
types natively, so an edit to `src/` is live on the next invocation — which is the entire point of
the workspace `devDependencies` line in the root `package.json`. `build` emits `dist/` for the
published tarball and nothing else reads it; see the publish note above for why the two halves
differ. `tsc` and not `tsgo`: the repo carries no bundler, and the artifact consumers install comes
off the stable compiler.

A verb is a **pure function of its dependencies** — the `*-verb.ts` modules compute a
`VerbOutcome` (exit code, stdout, stderr) and never write a stream or exit. The Effect CLI
layer in each group's `command.ts` does both. That split is what makes
each refusal as deterministically testable as each answer, which is why the tests can drive
an unreadable directory, a `gh` that exits 0 with the wrong bytes, and a base ref that
cannot be fetched — inputs a real tree cannot be asked to produce on demand.

Those dependencies are the **Effect platform services**, never a raw `node:*` import: the
filesystem is `FileSystem` / `Path` from `effect`
([.patterns/effect-platform-access.md](../../.patterns/effect-platform-access.md)) and the
subprocess is `ChildProcess` / `ChildProcessSpawner` from `effect/unstable/process`
([.patterns/effect-process-cli-shell.md](../../.patterns/effect-process-cli-shell.md)), both
satisfied by the one `NodeServices.layer` [`src/run.ts`](./src/run.ts) provides. A test
substitutes those same services rather than a hand-rolled double, so the seam under test is
the seam production uses. A read that could not be performed fails on the `E` channel — it
never resolves to an empty value a caller could forget to distinguish from a real one.

Two raw `node:*` reads survive, both named by that pattern doc rather than overlooked. **fd
0** stays a raw `node:fs` read at the boundary in [`src/io/stdin.ts`](./src/io/stdin.ts) —
the standing ruling, where `Stdio.stdin` is a considered-and-declined stream swap rather
than a missing service; the verbs take the read as an injected effect, so the `EAGAIN` and
TTY paths stay testable without a real descriptor. **`homedir()`** stays a raw `node:os`
read in [`src/eval/spawn-io.ts`](./src/eval/spawn-io.ts), because Effect v4 ships no
equivalent at all; it is a parameter default, so a test substitutes it without a service.

The delegation layer reads `process` — `cwd()`, `argv`, `execPath`, `env`, `exit()` — and that is
confined to [`src/delegate/entry.ts`](./src/delegate/entry.ts), the boundary the bin bootstrap calls.
The walk and the decision it feeds are Effects over `FileSystem` / `Path` / `ChildProcessSpawner`,
so every branch — including "an ancestor could not be probed" and "the spawn faulted" — is driven by
substituted services rather than by a real tree.
