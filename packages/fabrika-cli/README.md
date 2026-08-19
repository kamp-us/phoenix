# @kampus/fabrika-cli

The deterministic verb package [fabrika](../../claude-plugins/fabrika/) skills call.
`fabrika <group> <verb> …` dispatches to a registered verb group. The registered groups are
`adr`, the six verbs the `/adr` skill's derived contract specifies; `report`,
the three the `/report` contract specifies; `triage`, the intake-queue group the `/triage`
contract specifies; `build`, the fourteen the `/build` contract specifies; `plan`, the epic-plan
gate's; `review`, the eight the `/review` contract specifies; `review-ui`, the three the
`/review-ui` contract specifies
(capture a PR's preview, emit the `review-ui` verdict, or post a typed blocker note);
`ship`, the thirteen the `/ship` contract specifies; `map`, the eight the `/wayfinding`
contract specifies (chart one destination's fog, and drain its frontier); `spend`, what one fabrika run cost in
tokens; `lane`, the lane ledger the operator loop drives — a @demlik/tea machine
folded fresh from an append-only `events.jsonl` on every invocation; `wire`, which owns the
byte-level formats two skills meet through on a GitHub
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

**`fabrika` invoked the v1 CLI nowhere** — no import, no subprocess
([ADR 0238](../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). That package is
deleted now (#6100), so the rule is history rather than a live constraint; what it bought is that
nothing here needs porting or unhooking.

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
| In a **git worktree** of phoenix | that worktree's `packages/fabrika-cli` | — |
| In a consumer repo that installed it | that repo's pinned version | — |
| In a consumer repo that did **not** install it | the global | **yes**, naming both versions |
| In no repo at all | the global | no — deliberately |
| Running a copy from a **different repository** by path | nothing — it refuses, exit `126` | **yes**, naming both checkouts |

Rows four and five are the original design. Running the global outside any repo is a normal,
correct invocation, so it stays quiet. Running the global *inside a repo that asked for a specific
version* is the quietly-wrong case, so it says so out loud and names the global's version beside the
one the root manifest declared. Set `FABRIKA_GLOBAL_WARNING_DISABLED=1` to silence it.

The last row closes the one case that used to be quietly wrong ([#4956](https://github.com/kamp-us/phoenix/issues/4956)).
`node <other-repo>/packages/fabrika-cli/src/bin.ts` run from a cwd inside *this* repo looked
exactly like a global install on `PATH`, so it delegated — and answered from a repository you did
not name, with no warning at all. It is a live hazard for anyone reviewing from a second checkout: the CLI
reports the state of `main` while you are reading a branch. The two are separated by asking which
repository the *invoked copy* belongs to; an installed copy (anything under `node_modules`) belongs to
none, which is what keeps the global-install delegation exactly as it was. Either run it from inside
its own repository, or pass `--skip-infer` to make the copy you named serve the invocation.

Row two is the carve-out that refusal needed ([#5679](https://github.com/kamp-us/phoenix/issues/5679)).
A `pnpm link --global` install puts a checkout's own copy on `PATH`, so an agent standing in a
worktree who types the bare `fabrika` invokes the primary checkout's copy — a different checkout, and
the refusal swallowed it, leaving the bare command unusable from every worktree. `git worktree` gives
one repository several working trees, so the comparison is the repository, not the checkout: the two
trees' `$GIT_COMMON_DIR` is read off disk (`.git` directory, else the `.git` file's `gitdir:` and that
dir's `commondir`, per `gitrepository-layout(5)`) and equal common dirs delegate. A tree whose
repository cannot be established is treated as a different one, so the refusal is what an unreadable
answer falls back to.

Row three needs one more rule to hold, because the probe asks Node and Node answers about more than
the repo ([#5768](https://github.com/kamp-us/phoenix/issues/5768)). After the `node_modules` walk
fails, Node falls back to `NODE_PATH` — and the pnpm-generated global `fabrika` shim exports an
absolute `NODE_PATH` chain rooted at the checkout it was installed from. So a repo with no install
of its own still resolved one: the global's own copy, which read as "the repo-local install is this
copy" and swallowed the warning row three exists for. The probe therefore requires the resolved
install to live at or under the repo root; anything outside is `absent`, whatever Node found. The
same rule drops a copy hoisted into a directory above the repo, which is not that repo's install
either.

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
> invocation, and npm rewrites `bin`/`main`/`types`/`exports`/`engines` onto the compiled `dist/` at
> publish time. `files` is `["dist", "scripts"]` and `prepublishOnly` runs the build, so a tarball
> can neither miss `dist/` nor ship a stale one (#4784).

### The two Node floors

The two entry points need different Nodes, so the manifest carries two floors and never one number
(#5943):

| Floor | Where it lives | What it is | Who reads it |
| --- | --- | --- | --- |
| `>=22.12` | `publishConfig.engines.node` | what the compiled `dist/` runs on | consumers, via the tarball |
| `>=24` | top-level `engines.node` | what the `.ts` `bin` needs for type stripping | this workspace |

`publishConfig.engines` is a real field replacement, not a hopeful one: packing this package with
pnpm 10.27.0 (the `packageManager` pin `publish.yml` runs on) emits a tarball `package.json` whose
`engines.node` is `>=22.12` and whose `publishConfig` is stripped to `{"access": "public"}` — pnpm
copies a whitelisted field onto the manifest and deletes it from `publishConfig`, and `access` is a
publish setting rather than a manifest field, so it stays behind. So the dev floor never reaches a
consumer, and a Node-22 repo installs and runs with no `Unsupported engine` warning —
including under `engine-strict=true`, where `>=24` was a hard install failure rather than noise.

`>=22.12` is what the bundle was measured to need, not what it was assumed to need. Running
`dist/bin.js` down the Node ladder: 22.12 and up is clean; 22.11 works but warns
(`ExperimentalWarning: Importing JSON modules`, from [`src/version.ts`](./src/version.ts)'s
`import pkg from "../package.json" with {type: "json"}` — import attributes for JSON stopped being
experimental in 22.12); Node 20 and 18 throw, because `undici` in the dependency tree calls
`webidl.util.markAsUncloneable`, which lands in Node 22.

The dev floor stays `>=24` and is deliberately conservative — the `.ts` `bin` in fact starts on
22.18+, where native type stripping was backported, but nothing in this repo runs below 24. It is
also not the only home for that number: `volta.node` pins `26.2.0` here and at the root, and CI
reads `node-version-file: package.json`.

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
  `1` = usage error or the verb failed to run, `126` = the binary started but could not resolve an
  implementation, `127` = the verb never ran, `3`+ = the verb's own proven outcomes. **A non-zero
  exit is UNKNOWN** — read the status before the bytes. `2` is allocated by nothing: it is the one
  code a `PreToolUse` hook blocks the tool call on, so a fabrika exit seated there would deny a
  spawn as a side effect of its status ([#5423](https://github.com/kamp-us/phoenix/issues/5423)).
- **Fail closed on missing scope or state.** A zero-record scan is a failed read, not an
  answer ([ADR 0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)); an
  unreadable input resolves to a refusal, never to a permissive default.

## The `adr` group

The contract these seven implement is
[`claude-plugins/fabrika/skills/adr/contract.md`](../../claude-plugins/fabrika/skills/adr/contract.md).

| Verb | Answers |
|---|---|
| `adr next` | the next unused id — `max(fetched merged set ∪ open-PR claims) + 1` |
| `adr new` | scaffolds `.decisions/NNNN-slug.md` from the canonical template |
| `adr mint` | `next` and `new` in one call — allocates the id and writes the record with no gap between |
| `adr resolve` | each id's real filename and state: `live` / `landed` / `in-flight` / `absent` |
| `adr supersede` | rewrites an older record's `status:` line to a `superseded by` link to the newer record |
| `adr amend-in-part` | appends this id to an older record's `amended-in-part by` list |
| `adr sweep` | ranks the uncited live-accepted records this one may contradict |

Four behaviours are worth knowing before you call them:

- **`--base` is fetched before it is read.** Reading a stale local ref is the defect class
  the contract exists to close — it is how two lanes both minted ADR 0198, and how a stale
  checkout applied a withdrawn ADR 86 minutes after the withdrawal landed.
- **`mint` exists because an id read in one call is stale by the next.** `next` then `new` leaves
  the author's whole drafting turn between the read and the write, which put ADR 0284 on two pull
  requests ([#5841](https://github.com/kamp-us/phoenix/issues/5841)). It is still not a reservation
  — no id is visible to another lane until its pull request opens — and nothing catches a duplicate
  downstream: `decisions-index`'s `merge_group` run reports one on the batched ref, but it is not a
  required context, so the batch merges and `main` goes red until someone renumbers
  ([#5869](https://github.com/kamp-us/phoenix/issues/5869)). Still run the step-6 re-check.
- **`live` and `landed` are different answers.** `landed` means present on the base ref but
  `proposed`, `superseded` or `retired`; 36 of the 233 records on `main` are in that state,
  and citing one as settled law is the failure this split exists to prevent.
- **`supersede` / `amend-in-part` assert a one-line diff before writing.** An accepted ADR's
  decision text is immutable, so a rewrite that would touch any line but `status:` aborts
  with exit 15 and writes nothing.

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
The group's nine verbs (`queue`, `claim`, `provenance`, `homes`, `split`, `enrich`, `apply`,
`park`, `kill`) landed in the slices of
[#4831](https://github.com/kamp-us/phoenix/issues/4831); `repair-criteria` joined as the
corpus-repair verb ([#5744](https://github.com/kamp-us/phoenix/issues/5744)).

| Verb | Answers |
|---|---|
| `triage codes` | the exit taxonomy every verb in the group allocates from, one `<code>\t<meaning>` line per code |
| `triage apply` | stamp type, priority, audience, status and home as one owned-facet reconcile, read back positively. `--ready-for agent` additionally asserts the issue's live body carries an acceptance-criteria block the wire reader answers `Found` on, refusing on `16` before any label is written — an absent block routes back to `enrich`, a malformed one to `repair-criteria`. `--type epic` is exempt (its criteria arrive per child from the plan ledger) and `--ready-for human` is unaffected ([#6025](https://github.com/kamp-us/phoenix/issues/6025)) |
| `triage repair-criteria` | repair an acceptance-criteria block's shape — two repairs, composed in one pass: a level-drifted `## Acceptance criteria` heading rewritten to the conforming `###`, and, when the block carries no checkbox at all, its list items rewritten to unchecked checkboxes with each item's text byte-for-byte unchanged — plain bullets ([#6001](https://github.com/kamp-us/phoenix/issues/6001)) or an ordered `1.` list, one family per block ([#5981](https://github.com/kamp-us/phoenix/issues/5981)). One issue, or `--sweep` over every open issue with a per-issue outcome line; `--dry-run` plans everything and writes nothing, answering `would-repair` with the repairs it would make, so the set of bodies about to be edited is reviewable first. Every repaired body gets one disclosure comment naming its repairs, posted after the read-back — an in-place edit of a filed body GitHub keeps no history of leaves no other record. Authored region only, and anything that is not a pure shape rewrite is refused on `14`, never guessed — a drifted heading text, a section mixing the two list families, prose or another block standing between the list's items, an empty item, a checkbox already beside the items, or a converted item the reader counts no criterion at (the repaired block must read back exactly one criterion per line it rewrote) |

Three properties of that substrate are worth knowing:

- **Every verb in the group allocates from one table** ([`src/triage/codes.ts`](./src/triage/codes.ts)),
  so a code means one thing across this group. Where it overlaps the two `report` writing
  verbs — `3`, `5`, `6`, `7`, `8`, `9`, `10`, `11` — the meanings match **code for code**, so
  a caller driving both groups in one sweep reads one meaning. `report dedup` used to break that
  inside its own group, seating *queue unreadable* / *search index unreadable* on `3`/`4` from a verb
  file the alignment check could not see; they are `27`/`28` in the group table now, and a check over
  every verb file keeps the next one from hiding the same way
  ([#5296](https://github.com/kamp-us/phoenix/issues/5296)).
- **`4` is a deliberate gap.** It once fused "the target issue is proven absent" with "the
  target issue could not be read". `7` and `11` took the halves, and the slot is left
  unallocated rather than compacted — a gap is cheaper than a collision, and it keeps the
  alignment with `report file`, where `4` is a body-section failure no verb here performs.
- **Every list read pages and reports its scanned count** on stderr
  ([`src/triage/scope.ts`](./src/triage/scope.ts)). A verdict driven by a silently truncated
  read is a verdict over unknown scope; pagination fixes the reach, and printing what was
  scanned is what makes the reach checkable from outside the process.

## The `build` group

Everything one construction lane needs, from the candidate pool to the opened pull request. The
group implements
[`claude-plugins/fabrika/skills/build/contract.md`](../../claude-plugins/fabrika/skills/build/contract.md).

| Verb | What it answers |
|---|---|
| `build pick` | the ranked candidate pool, with every excluded issue reported beside it under the axis that refused it. Four axes report: `out-of-scope` and `audience-not-agent` from the shared admission test, `unreadable`, and `no-acceptance-criteria` — a body with no block the wire reader answers `Found` on, which is a lane that could otherwise only fail at `review criteria` once a whole build was spent. The body rides the listing read the filter already performs, so the axis costs no second call ([#6025](https://github.com/kamp-us/phoenix/issues/6025)) |
| `build issue` | the claimed issue's body and its criteria, transporting the wire read's three arms — `found` / `absent` / `malformed` — as distinct facts on exit 0. It is a read verb and refuses none of them; the refusals live at the stamp and the pick |

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
| `ship scope` | head, lifecycle state, linked issue, artifact classes with their required namespaces, and the three-state §CP classification |
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

## The `map` group

Charting one destination's fog. The group implements
[`claude-plugins/fabrika/skills/wayfinding/contract.md`](../../claude-plugins/fabrika/skills/wayfinding/contract.md).
The map is a GitHub issue carrying `wayfinding:map`; its frontier is that issue's **sub-issues**,
and the topology between them is GitHub's **native issue-dependency edges** — never prose in a body.

| Verb | What it answers |
|---|---|
| `map open` | the map for a destination — minted or resumed, refusing one that is not fog |
| `map read` | the whole state: five sections, one row per frontier ticket, the frontier token, the digest |
| `map ticket` | one frontier ticket, filed and linked and edged and spliced onto the map, as one act |
| `map lane` | a research lane on one ticket, claimed under this run's nonce |
| `map finding` | a lane closed with an outcome from a closed set of three |
| `map fork` | where a question is being answered instead — a `grilling` session or a `prototyping` spike |
| `map record` | the lockstep: the answer under `## Decisions`, the row off the frontier, the ticket closed |
| `map descope` | a rejected direction appended to the never-graduating out-of-scope section |

- **A line's section is not its state.** State is resolved from the ticket's marker, its `state` on
  GitHub and its edges; the body rows are re-rendered from that answer
  ([`src/map/frontier.ts`](./src/map/frontier.ts)). v1 encoded state as which heading a bullet sat
  under, in a body no shipped tool wrote, and then had to read "tolerantly" to cope with its own
  drift.
- **All four frontier tokens exit `0`.** `awaiting-founder`, `lanes-pending`, `clear` and `empty` are
  four answers. A frontier holding open questions is the skill working, and seating it on a non-zero
  code would make `[ $? -ne 0 ]` read "the fog is not cleared yet" as "the verb never ran".
- **Every body write is a compare-and-set slice.** `--digest` guards the write and the write replaces
  one section's bytes, so a concurrent edit to another section survives even when the guard admits
  the write ([`src/map/body.ts`](./src/map/body.ts)).
- **Lane traffic goes to the ticket, never to the map body.** `map finding` writes a comment and
  releases the lane; only `map record` touches the body, so a parallel burndown sees one body write
  per *resolution* rather than one per lane event.
- **The lane key is the caller's run nonce**, eight lowercase hex, passed explicitly. A session id is
  pane-constant and shared across sibling subagents, so two lanes of one run would key onto one
  namespace and each would read the other's claim as its own.
- **A `404` on a dependency read is a verdict about the issue, not about its edges**
  ([`src/io/edges.ts`](./src/io/edges.ts)). Every edge read is preceded by an existence read, every
  list pages, and an empty read that cannot be *proven* empty is `11` — never an empty frontier.
- **`10` is a deliberate gap.** No `map` verb accepts a label flag or writes a classification, so the
  base's `10` is unreachable here rather than merely unused
  ([`src/map/codes.ts`](./src/map/codes.ts)).

## The `grill` group

The contract is
[`claude-plugins/fabrika/skills/grilling/contract.md`](../../claude-plugins/fabrika/skills/grilling/contract.md).
A **grilling session** is one GitHub issue carrying the `grilling:session` label; rounds of
questions, the answers an agent establishes and the rulings the founder makes all live in its
comments.

| Verb | Answers |
|---|---|
| `grill open` | opens, or resumes, the session issue for a topic — `created` says which |
| `grill round` | validates one round read from stdin, posts it, and returns its number, digest, ids and comment ids |
| `grill answer` | records an agent-established answer to a `fact` question, behind a kind guard |
| `grill rule` | records a founder ruling, refusing without a verbatim dated authorization |
| `grill read` | per-question state, ACL-resolved and digest-checked, plus the frontier token and every disregarded marker |

Four properties are worth knowing before you call them:

- **A recorded ruling is bound to an authority, not to a string.** Every marker's author is
  resolved against repository permissions
  ([ADR 0055](../../.decisions/0055-acl-sourced-review-authz.md)), and a permission read that
  *fails* is UNKNOWN, never a demotion. No verb decides authority from what a comment says
  about itself.
- **A ruling is bound to the text it ruled.** The round digest covers the round's question text
  and nothing else, so re-wording a question makes the recomputed digest differ and `grill read`
  reports it `stale` — un-ruled again. That neutrality rests on a prohibition: no verb ever edits
  an existing comment.
- **All four frontier tokens exit `0`.** `awaiting-founder`, `facts-pending`, `clear` and `empty`
  are four answers. An open frontier is this skill working, not a failure.
- **A malformed marker is visible, never absent.** `grill read` never refuses on marker content:
  a marker that is malformed, unauthorized or bound to nothing is a `disregarded` row at exit `0`.
  Refusing would let one bad comment suppress the whole frontier answer.

This group records no merge-gating verdict and computes no second answer to control-plane
membership, pitch approval or triage classification — each is already enforced at its own gate.

## The `spike` group

The contract is
[`claude-plugins/fabrika/skills/prototyping/contract.md`](../../claude-plugins/fabrika/skills/prototyping/contract.md).
A **spike** is one GitHub issue carrying the `prototyping:spike` label, bound to a throwaway
workspace that lives under the OS temp root — **never inside the repository** — and keyed on a
per-run nonce.

| Verb | Answers |
|---|---|
| `spike open` | mints the spike issue and this run's workspace, and binds the two in a manifest |
| `spike run` | executes one command in the workspace and appends an immutable evidence record |
| `spike capture` | posts the decision plus the log's own run table, reads it back, and closes the spike |
| `spike dispose` | proves the tree is unchanged and the capture still covers the log, removes the workspace, and proves it is gone |
| `spike status` | one run's spike state, workspace presence and evidence count |

Five properties are worth knowing before you call them:

- **"Ran and answered no" and "could not run" are opposite answers.** `spike run` exits `0`
  whatever the command returned — the command's own status rides in the payload as `commandExit`
  — and exits `11` only when the command could not be executed at all. This is the one place in
  the group where the exit code and the answer are deliberately about different things.
- **The key is a per-run nonce, minted from a cryptographic source.** No verb reads
  `CLAUDE_CODE_SESSION_ID` or any session variable, and no verb asks a caller to invent a value,
  so two concurrent spikes cannot collide on a workspace ([#4544](https://github.com/kamp-us/phoenix/issues/4544)).
- **Disposability is a property, not an intention.** `spike open` records a digest of
  `git status --porcelain=v1 --untracked-files=all --ignored=matching`, and `spike dispose`
  recomputes it *before* it removes or posts anything — so a leak refuses on `17` with the
  workspace intact. `--ignored=matching` is load-bearing: a build cache or a `node_modules/` is
  exactly where a prototype writes.
- **A decision with no recorded run is a self-report.** `spike capture` reds on a log holding zero
  runs (`14`, ADR [0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)), and the
  comment it posts transcribes each run's command and status rather than summarising them.
- **`spike status` is near-total on purpose.** Its consumer is a session resuming cold, so an
  absent workspace is a **fact** at exit `0` while the same absence is a refusal (`12`) in the
  mutating verbs. The bound is still ADR 0092: an unparseable record is `4` and an unreadable
  state is `11`.

This group gates no merge, judges no pull request and emits no verdict, so it registers in no
verdict namespace and no wire format — a `spike` marker there would be one `wire read` could never
read back.

## The `handoff` group

The contract is
[`claude-plugins/fabrika/skills/handoff/contract.md`](../../claude-plugins/fabrika/skills/handoff/contract.md).
A **pack** is one comment on the work's issue, carrying two halves: the four sections the model
wrote, and the ground state the verb derived. It is how one session hands its work to the next when
the two share no memory, no checkout and possibly no machine.

| Verb | Answers |
|---|---|
| `handoff capture` | the ground state — branch, head, reachability, tree, base, issue and pull-request state — as one JSON object |
| `handoff take` | composes the pack from stdin plus a fresh capture, leak-scans it, posts it as one comment, and reads it back |
| `handoff read` | the latest sealed pack, its two halves, and the drift field by field against the ground re-derived now |
| `handoff claim` | claims that pack, keyed on the run nonce — `held` or `resumed`, and a refusal on anyone else's |

Five properties are worth knowing before you call them:

- **The caller cannot supply the proven half.** `take` derives it itself, because a
  caller-supplied ground state is the premise-inheritance the two-half split exists to prevent
  (#4133). The body arrives on stdin only: there is no `--body` and no `--body-file`, so a
  machine-local path has no route into a posted artifact (#3086, #3173).
- **The section set is closed.** A fifth heading, prose before the first heading, or text after the
  JSON fence is a refusal on the way in and on the way out. An artifact whose section set is open
  can steer its receiver past the artifact, and the receiver cannot tell the format's own words
  from someone else's.
- **There is no way to read a pack without its drift.** `read` re-derives the ground against the
  **packed** branch, never the successor's `HEAD`, and reports the sixteen observable fields of the
  nineteen it digests. A caller who could skip the drift check would sometimes skip it, and a pack
  read as current while stale is the failure this group is built against (#3330).
- **Unreachable work refuses rather than warns.** An unpushed commit and a modified tracked file are
  both invisible to a fresh checkout, so `take` refuses `12` and names the remedy — which is the
  caller's, outside this group. `--declare-unreachable` records the loss instead of silencing it.
- **The same fact is `0` on `read` and `13` on `claim`.** An issue with no pack is `read`'s ordinary
  `none` token, because most issues have none; `claim` *acts*, so claiming a pack that does not
  exist is a request it cannot honour.

This group applies no label, closes nothing, opens no pull request, emits no verdict marker, and
pushes nothing. Nothing it records can block a merge — a session state that gated one would make
every interrupted session a blocked one.

## The `heal-ci` group

The contract is `claude-plugins/fabrika/skills/heal-ci/contract.md`, which this group was written
against. It has not landed yet — that path is where the contract will live, so it is left unlinked
rather than pointing at a file that is not there.
This is the repair lane: it takes a stranded or red pull request and drives it back toward green
without a human reading logs. A **strand** is a PR nobody is moving; a **signature** is the one row
of a closed table a failure log matches.

| Verb | Answers |
|---|---|
| `heal-ci diagnose` | one PR's stall class from an ordered, total predicate chain, with the evidence that proves it |
| `heal-ci sweep` | every open PR classified with its strand age — the scheduled surface |
| `heal-ci surface` | declared required contexts against the runs that actually post at the head |
| `heal-ci logs` | the failed-job log text for **every** failing gating context at a head |
| `heal-ci classify` | pure: log text on stdin → one signature from a ten-row ordered table, default-deny |
| `heal-ci rerun` | the at-most-once transient rerun, precondition re-derived inside the verb |
| `heal-ci note` | the durable stop-path comment |

Six properties are worth knowing before you call them:

- **Every classification is an exit-`0` answer**, `red` and `wedged` and `not-open` included. A
  non-zero exit means the verb could not produce an answer — v1's green head exited `3`, which made
  its most successful outcome a failure to every caller using the toolkit's own `|| exit 1` idiom.
- **The chain is ordered, and the order is the contract.** `check-surface` fires above `red` because
  a required context no run produces cannot be healed by anything a log classifier does, and
  `attended` sits above every strand class because a PR whose author pushed two minutes ago is not
  abandoned.
- **`unprobeable` is not `no-requirements`.** The branch-protection endpoint answers `404` both when
  a branch is unprotected and when the token cannot see it, so `no-requirements` additionally needs a
  successful rules read that returned nothing. Where the surface is unprobeable, `diagnose` skips
  that arm with a notice rather than passing it — a permission the token lacks never reads as a
  surface that is clean.
- **`unclassified` is a third token, deliberately.** Fusing "I recognise a deterministic bug" with "I
  recognise nothing" means a caller can never count how often the classifier is guessing, and the
  routing differs. There is no path from ambiguous input to `transient`.
- **The rerun guard lives in the verb.** `rerun` re-derives the head binding, the failure state and
  at-most-once — from two independent, fully paginated signals — then requires a **read-back new
  attempt** before any marker is written. v1 wrote its marker on the strength of the dispatch
  response and thereby blocked every future rerun of a run that never re-ran. Exit `16` is the loud
  one: the rerun landed and the record did not.
- **`sweep` writes nothing.** It files no issue, assigns nobody and spawns nothing (ADR 0205): a
  detector emits claimable work and normal pull adopts it. A board it could not read whole is a
  refusal, never a shorter list.

Filing is `report file`'s and is not respecified here, which is why `4` stays a deliberate gap in
this group's table.

## The `glossary` group

The contract is
[`claude-plugins/fabrika/skills/glossary/contract.md`](../../claude-plugins/fabrika/skills/glossary/contract.md).
A **register** is one of the two markdown files the repo's canonical vocabulary lives in —
`.glossary/TERMS.md` for the domain nouns and `.glossary/LANGUAGE.md` for the architecture
vocabulary — and every verb here resolves it against the **target** repo's root, never against the
installed plugin.

| Verb | Answers |
|---|---|
| `glossary init` | creates a register that does not exist, so a fresh repo is not a dead end |
| `glossary drift` | the surfaces that moved since a register last changed, and the candidate coinages in them |
| `glossary lookup` | whether a term is already declared, and what overlaps it |
| `glossary sections` | the live section names of a register, and each one's row count |
| `glossary add` | inserts or replaces one row, alphabetically placed and byte-preserving elsewhere |
| `glossary check` | row-shape, duplicate-key, cross-register, ordering and citation-liveness defects |

Five properties are worth knowing before you call them:

- **Absent and present-and-empty are different facts and never share a code.** An absent register
  is `bootstrap` on exit `0` — day one in an adopting repo
  ([#4776](https://github.com/kamp-us/phoenix/issues/4776)) — while a register that is present and
  holds zero rows reds `check` on `7`, because a scan of nothing must never report `clean`
  (ADR [0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). A register that could not
  be *read* is `11` throughout.
- **The whole first cell is one key.** `Database (tag)` and `tag` are different terms that
  *overlap*; a parenthetical is a disambiguating qualifier, not an alias, and splitting one produced
  three false duplicates the last time it was tried
  ([#4206](https://github.com/kamp-us/phoenix/issues/4206)). `lookup` reports the overlap and leaves
  the judgement to the skill.
- **`add` changes one line and proves it.** It asserts the composed text differs from the original in
  exactly its own splice before writing (`15` aborts with nothing written), then re-reads the row
  that landed and refuses on `9` when it is not what was composed — a different fact from a write
  that failed, which is `8`.
- **Suppression is equality on the normalized key.** v1 suppressed a drift candidate when a declared
  term contained it *or* it contained a declared term, which against a 226-row register measured
  about 10% precision ([#4481](https://github.com/kamp-us/phoenix/issues/4481)). And the tokenizer is
  Unicode-classed rather than ASCII, so the Turkish product nouns the glossary exists for are visible
  at all.
- **Two defect classes are deliberately not computed.** Machine-local paths in a register and dead
  internal links are each decided by a merge-blocking gate, so `check` states the expectation and
  leaves the verdict where it is enforced — a second answer could report `clean` while the gate reds.
  Exit seats `5` and `6` are held empty for exactly that reason rather than left unallocated.

This group reaches no network and touches no GitHub artifact: every read is the local tree. It gates
no merge and emits no verdict, so it registers in no verdict namespace and no wire format.

## The `ci` group

The workflow plumbing, migrated here from the v1 CLI alongside the guards
([#6099](https://github.com/kamp-us/phoenix/issues/6099)). These are **not** guards: they are the
release path and the build path, where a mistake breaks cutting a release or breaks the evidence a
merge gate reads, rather than breaking a check.

| Verb | Answers |
|---|---|
| `ci changelog` | one Keep-a-Changelog release section derived from a range's closed-issue/merged-PR metadata (ADR [0069](../../.decisions/0069-derived-changelog-from-shipped-work.md)) |
| `ci pr-body` | a standing Release PR body with every stray HTML tag neutralized, so release-please can parse its own PR back ([#5946](https://github.com/kamp-us/phoenix/issues/5946)) |
| `ci annotate` | a typecheck's output echoed through unchanged, with each tsc diagnostic re-emitted as a `::error` workflow command ([#3873](https://github.com/kamp-us/phoenix/issues/3873)) |
| `ci evidence` | the ADR [0054](../../.decisions/0054-run-evidence-bundle.md) §2 run-evidence manifest for a crabbox run, which `ship evidence` reads back and binds to the head SHA |

Two things in the group do not follow the ordinary verb shape, and both are forced:

- **`ci annotate` writes its own streams** instead of returning a `VerbOutcome`. The outcome shape
  buffers stdout until the verb finishes, and the whole point of a pass-through filter is that the
  CI log stays live while the typecheck runs. It also always exits `0` — it is a reporter, and the
  typecheck's redness rides on the producer's exit code through `set -o pipefail`, so a non-zero
  exit here would only ever mask which side of the pipe actually failed.
- **`ci-required` is a bare bin, not a verb** —
  [`src/ci/required-bin.ts`](./src/ci/required-bin.ts), the aggregator that decides whether every
  should-have-run gating job actually ran (ADR
  [0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). Its gate job runs on every PR
  and installs no dependencies, so nothing on its entry path may import `effect`; a registered
  `Command` would put the whole CLI dependency tree on the always-on aggregator's critical path. The
  job set it covers is declared once, in `ci.yml`'s `CI_REQUIRED_JOBS`, beside the `needs:` list it
  must match — a declared job whose `env:` keys are absent reds rather than reading as not-required.

## The `guard` group

The repo's fail-closed CI gates, migrating here from the v1 CLI (epic
[#5720](https://github.com/kamp-us/phoenix/issues/5720)). Unlike every other group this one nests —
a guard is its own subcommand and `check` is its leaf — so a workflow step and a human reproducing
its red type the same thing:

```bash
node packages/fabrika-cli/src/bin.ts guard readme-guard check
```

| Verb | Answers |
|---|---|
| `guard readme-guard check` | whether every real `packages/*` workspace member carries a `README.md` |
| `guard skill-lint check` | whether the `claude-plugins/` skill + agent corpus holds a GraphQL-path `gh` call, an unparseable frontmatter block, a bare `git push` in a runnable block, or a plugin path literal that only resolves inside this repo |
| `guard path-filter-guard check` | whether `deploy.yml`'s `deploy:` run-set still matches `ci.yml`'s `e2e:` one, globs and `token`/`base` diff basis alike |
| `guard change-detect-guard check` | whether change detection is still on API-free git mode (`token: ''`) rather than the flaky API-HTML path |
| `guard codeowners-cp check` | whether every path the §CP boundary marks control-plane is owned by a human team in `.github/CODEOWNERS` |
| `guard decisions-index validate` | whether the ADR corpus holds a duplicate id, a filename that disagrees with its frontmatter, or a missing index field |
| `guard design-token-guard check` | whether component CSS holds a dead `var()` ref, a raw hex outside the raw-scale layer, or an off-grid px over its file's ceiling |
| `guard design-inventory check` / `generate` | whether the committed component inventory still matches the JSDoc it is extracted from, and the one write mode that regenerates it |

Three things are shared by the group rather than rebuilt per guard, which is the point of it
([#6093](https://github.com/kamp-us/phoenix/issues/6093)):

`skill-lint` also owns its own walk, and that is deliberate: in the v1 CLI the corpus walk, the
zero-scope floor and the per-plugin coverage assertion lived in forty lines of workflow bash, which
put four fail-closed decisions where no test could reach them and made a local repro a retyped
`find`. They are verb code now ([#6098](https://github.com/kamp-us/phoenix/issues/6098)).

- **Scope.** `members.ts` resolves real workspace members — a directory under a declared
  `pnpm-workspace.yaml` glob that carries a `package.json`. A dead-shell directory is not a member,
  and a read that fails is never an empty scan.
- **The change.** `changed-files.ts` resolves what a change-scoped guard diffs against, per CI leg:
  a PR's target branch, the merge queue's batch base (ADR
  [0132](../../.decisions/0132-merge-queue-for-base-freshness.md)), a dispatch's default branch, or no
  baseline at all on `push`. An event it cannot read is `Unresolvable` — never an empty diff.
- **The verdict.** `verdict.ts` seats every guard on one taxonomy: `0` clean, `12` violation, `7`
  zero scope (ADR [0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)), `11` a read
  failed so the answer is UNKNOWN. Three numbers, not one, because CI reds on all of them and a
  human fixing one needs to know which. The report goes to stderr, with GitHub `::error`
  annotations beside it under Actions — the runner feeds both a step's streams into one command
  parser, so an annotation on stderr renders exactly as one on stdout, and stdout stays empty on
  every refusal the way the interface convention requires.

## The `governance` group

The contract is
[`claude-plugins/fabrika/skills/governance/contract.md`](../../claude-plugins/fabrika/skills/governance/contract.md).
The **governance namespace** is derived from a diff, named either by a PR or by a `--base`/`--tip`
commit range (an epic child has no PR mid-run) — required when any changed path sits under
one of four harness roots (`.decisions/`, `.claude/`, `.github/`, `claude-plugins/`) — and this group
answers the mechanical half of the judgment a governance verdict rests on.

| Verb | Answers |
|---|---|
| `governance scope` | whether the diff derives the namespace, over which roots, with the bound head or the named range, the `self` flag and the records in the diff |
| `governance sweep` | the uncited live-`accepted` records whose domain a subject touches, ranked, for a subject in a bound commit or in the corpus |
| `governance guards` | the anchored invariants the bound diff removes or modifies, and the guard-bearing files it touches |
| `governance base` | this skill's own text at the subject's merge base, whether the subject is a PR or a range — the self fence's bytes |
| `governance post` | the single sanctioned emit of the `governance` namespace verdict |
| `governance digest` | the decision records that landed in a window, with each landing commit and its anchor delta |
| `governance readout` | the digest-publishing protocol: compose, upsert, read back |

Five properties are worth knowing before you call them:

- **This is not the §CP answer, and `governance scope` says so on stderr on every run.** fabrika's
  §CP model is CODEOWNERS-only with no semantic detection, so a second answer here could contradict a
  merge-gating verdict. What this derives is a separate namespace whose *verdict* is the skill's
  judgment.
- **Nothing is re-derived that already ships.** The root list and its predicate come from
  [`review/classes.ts`](src/review/classes.ts) — one derivation, read by `ship scope`, `ship gate`'s
  required-set floor and `governance scope` alike; the ranking core comes from
  [`adr/sweep.ts`](src/adr/sweep.ts); the commit binding, the leak predicate and the read-back
  normalizer are all imports.
- **No outcome here is a clearance.** `sweep`'s `no-overlap` carries that sentence verbatim in its
  `reason`, and `guards`'s `no-anchors-in-reach` is the mechanical floor reporting its own silence: a
  guard weakened in prose carrying no anchor is invisible to the scan by construction.
- **The anchor inventory lives in the guarded file.** An anchor is the `<!-- anchor: NAME -->` comment
  a skill already carries, so the set cannot rot while the guards move — which is the whole design
  difference from v1's hardcoded prose list inside the reviewing skill.
- **The readout gates nothing.** `governance readout` writes one comment and nothing else: no label,
  no PR, and no exit code meaning "the corpus is in a bad state", because a digest that could red
  would be the human gate the [#4927](https://github.com/kamp-us/phoenix/issues/4927) ruling retired
  under a new name.

The group emits the `governance` namespace through the shipped
[`verdict-marker`](src/wire/verdict-marker.ts) format and publishes its digest through
[`governance-digest`](src/wire/governance-digest.ts).

## The `pattern` group

The contract these five implement is
[`claude-plugins/fabrika/skills/write-pattern/contract.md`](../../claude-plugins/fabrika/skills/write-pattern/contract.md).
A **pattern doc** is one flat `<slug>.md` under a doc directory (`.patterns` by default),
registered by one row in that directory's `index.md`.

| Verb | Answers |
|---|---|
| `pattern corpus` | the library at a base ref: every doc, its registration, its section, its last-touching commit |
| `pattern drift` | whether the in-repo source a doc cites moved since the doc was last written |
| `pattern anchor` | whether the dependency version a doc declares still matches what the workspace pins |
| `pattern new` | scaffolds `<dir>/<slug>.md` from the canonical template |
| `pattern register` | inserts the doc's row into `<dir>/index.md` under a named section |

Five properties are worth knowing before you call them:

- **Every outcome exits `0`, including the empty ones.** `corpus` answers `absent` for a directory
  that is not in the tree and `none` for one that is and holds nothing; `drift` answers
  `unanchored`; `anchor` answers `unanchored`. Exit `7` is deliberately unseated — no verb here
  judges over a corpus, so none has a vacuous pass to prevent, and refusing on an empty library
  would leave a repo adopting fabrika unable to write its first pattern doc
  ([#5254](https://github.com/kamp-us/phoenix/issues/5254)).
- **`unanchored` is not a clearance.** It says the doc cites nothing the verb can follow, so drift
  there is *unanswerable* — read the source by hand. Reporting it as `current` would be a clean pass
  over nothing, the shape ADR [0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)
  forbids; the group says so in vocabulary rather than in an exit code, because a verb that refused
  would break the pipe its answer crosses.
- **Registration is three-valued.** `unknown` — the index is absent, or holds no markdown table —
  is its own value, because rendering it as `unregistered` would report a defect the verb never
  proved and send a caller to add rows to a file that cannot hold them. A doc counts as registered
  only when a table row's **first cell** links its filename; a mention in prose is not a
  registration.
- **An unresolved citation is counted, never a finding.** Pattern prose legitimately cites external
  dependency source trees, and such a path is indistinguishable from a deleted in-repo one by
  resolution alone. `drift` names each on stderr and excludes it from the moved set, inheriting
  `pointer-guard`'s `.patterns/**` exclusion rather than repeating the false positive it escaped.
- **`register` proves its diff before it writes.** The index is hand-curated, carries prose between
  its tables, and is edited by lanes this verb cannot see, so an insertion that changed any line
  beyond the new row aborts on `14` with nothing written — and the row is read back after.

The two reads are deliberately different: `corpus`, `drift` and `anchor` read at a fetched `--base`,
because the question they answer is what the repository already holds; `new` and `register` write the
**working tree**. A doc created by `new` is therefore invisible to `corpus` until it is committed.

This group is an authoring surface: it emits no verdict marker, joins no gate or ship namespace,
registers no wire format, needs no repository token and writes to no board surface. A `.patterns/*.md`
diff gates on the doc review namespace like any other doc change.

## The `wire` group

A **wire format** is the byte-level agreement two skills meet through on a GitHub artifact —
the acceptance-criteria block on a sub-issue body, the verdict marker on a PR, the
handoff pack one session leaves the next. Each one is
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
| `wire doc-section` | one markdown section of the document on stdin (or `--file`), by ATX heading — a shell's single-section contract lookup instead of a whole-file read (#5966) |
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
- **`handoff-pack`'s read side refuses instructions it does not own.** Its sections are
  closed, so a pack carrying an extra heading or a sentence outside every section reads `Malformed`
  rather than `Found` — coordination output that cannot steer its receiver past the artifact
  ([`handoff-pack.ts`](./src/wire/handoff-pack.ts)).
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

## The `lane` group

The minimal lane ledger the operator loop drives by hand
([#5673](https://github.com/kamp-us/phoenix/issues/5673); engine direction recorded on
[#5570](https://github.com/kamp-us/phoenix/issues/5570), de-risked by the recorded-run spikes
[#5671](https://github.com/kamp-us/phoenix/issues/5671)/[#5672](https://github.com/kamp-us/phoenix/issues/5672)).
A lane is a directory — `.fabrika/lanes/<n>/workflow.json` plus an append-only `events.jsonl` —
and **fold = state**: every verb is a fresh process that re-folds the whole log through a
[@demlik/tea](https://github.com/kamp-us/demlik) Transitions machine; no resident process, no
snapshot. Lane state is local and never committed (the repo's `/.fabrika/` gitignore entry).

| Verb | Answers |
|---|---|
| `lane status` | the derived state: compound `stateValue` (active phase → per-task leaf, future phases `"waiting"`), `status` active/done, per-task `{retries, maxRetries, …}` context and the tripped tasks in `errors` |
| `lane transition` | records one operator event after the machine accepts it — `{previous, event, current, taskAffected}` |
| `lane history` | the log verbatim, one `{task, event, at}` per event — `from`/`to` are reconstructible by folding, never stored |
| `lane print` | the compiled topology: phases, the two workflow terminals, and each state's legal events |
| `lane stale` | every lane on disk with the age of its last event and one verdict — which lanes are non-terminal, unparked and silent past `--older-than` (default 60 minutes), so a dead operator is detectable instead of invisible |
| `lane claim` / `lane release` | who is driving this lane: the same detect-then-tiebreak race `build claim` runs, in the driver's own `lane-claim:` namespace, so the builder a driver spawns claims the same issue and wins ([#5761](https://github.com/kamp-us/phoenix/issues/5761)). A `chore:<name>` key carries no board number and answers `unclaimable`/`inert` at exit 0 |

To open a lane, copy a template in and speak the operator's six events —
`DONE` / `PASS` / `FAIL` / `BLOCKED` / `WIP` / `UNBLOCKED`:

```bash
mkdir -p .fabrika/lanes/5673
cp packages/fabrika-cli/src/lane/templates/coder.workflow.json .fabrika/lanes/5673/workflow.json
fabrika lane transition 5673 WIP     # queued → build (--task is implied on a single-task lane)
fabrika lane status 5673
```

Three behaviours are worth knowing before you call it:

- **An invalid event refuses loudly and appends nothing.** An event the current state holds no
  cell for surfaces tea's own `NoCellError` verbatim at exit `12`, and `events.jsonl` is left
  byte-identical — where XState silently swallows an unhandled event, the machine here names it
  (#5671, run 8). The six-event vocabulary, the active-phase check and the finished-workflow
  check refuse the same way.
- **The compiler recognizes shapes, never guard names.** An array on an event is read
  structurally as `[retry-while-retries-remain, else-fallthrough]`; a transition targeting a
  `history` node resumes the state the task left, carried as a `was` field in the folded state;
  a phase's `onDone` pair names the workflow terminals. `guard`/`actions` strings in
  `workflow.json` are inert data — there is no name-normalization anywhere.
- **One committed template today.** [`src/lane/templates/coder.workflow.json`](./src/lane/templates/coder.workflow.json)
  is the static single-issue coder machine: `queued → build → review → ship`, review `FAIL`
  retried on a budget of 2 then frozen (freeze-after-2 as data), `BLOCKED`/`UNBLOCKED`
  suspend-resume from any working state, and ship `BLOCKED` parking in `human:cp-approval`
  until the approval lands as `UNBLOCKED`. Per-type templates beyond it are deliberately out of
  scope until a real lane snaps against the six-event vocabulary (#5570).

## The `recipe` group

The standing driver recipes, versioned once instead of retyped nightly
([#5840](https://github.com/kamp-us/phoenix/issues/5840)). A recipe is one deterministic verb with
named exits over a fixed sequence that has no judgment in it: it relays a decision another verb
already owns and never derives one (ADR
[0228](../../.decisions/0228-scripts-relay-never-derive.md)). Every mutation is proven by a
read-back before the verb reports success.

| Verb | Answers |
|---|---|
| `recipe unpark` | whether a parked lane's park is a known recipe, and on a known one clears it — `lane transition … UNBLOCKED`, emitted only after a second fold reads the task out of the park |
| `recipe rerun` | the failed workflow runs at a PR's live head, rerequested only behind a `governance` PASS bound to that head, each proven by re-reading its own run record |
| `recipe route` | which recipe a chore-lane state applies, and which of the machine's six events one of that recipe's exits folds to |

Each verb's `--help` is its interface — the exit table lives there, not here:

```bash
node packages/fabrika-cli/src/bin.ts recipe unpark --help
```

Two behaviours are worth knowing before you call it:

- **Known clears, novel escalates, and both are exit codes.** `unpark`'s `12` is a park whose cause
  is outside the recipe table — nothing written, route it to a human — while `13` is a known recipe
  whose clearing condition is simply not met yet. `recipe route --exit` folds the first to `BLOCKED`
  and the second to `WIP`, so how autonomous a chore drive is never depends on a caller's reading.
- **Two recipes are deliberately absent.** The acceptance-criteria heading repair is
  [`triage repair-criteria`](#the-triage-group), landed with its producer fix
  ([#5744](https://github.com/kamp-us/phoenix/issues/5744) /
  [#5565](https://github.com/kamp-us/phoenix/issues/5565)); orphaned-worktree reclamation is
  [#5197](https://github.com/kamp-us/phoenix/issues/5197)'s port. Neither is re-implemented here —
  a recipe for work another ticket owns buys a workaround and pays twice.

## The `spend` group

What one fabrika run cost, in tokens, read from its transcript
([#5007](https://github.com/kamp-us/phoenix/issues/5007), epic
[#4779](https://github.com/kamp-us/phoenix/issues/4779)).

The meter is fabrika's own ([`src/spend/token-spend.ts`](./src/spend/token-spend.ts)), not v1's.
`billed` is *specified* by ADR 0112 §2, not chosen, so the two implementations are held to one
ruler by a committed transcript fixture both packages' unit tiers assert against —
`src/spend/fixtures/one-ruler/`.

| Verb | Answers |
|---|---|
| `spend read` | one run's billed token spend, its four `usage` components, the ex-cache-read comparator, its billed turn count and its model |
| `spend rollup` | what **all** of fabrika's recorded runs cost, summed out of the durable ledger and broken down by day, by skill and by stage-and-arm |

Three behaviours are worth knowing before you call it:

- **The cache-read share stays its own number.** It dominates `billed` and grows with turn
  count, which makes it the context-bloat signal; folding it into one total is what hides the
  thing the measurement exists to show.
- **"I could not measure it" is never a zero.** Exit `7` is a transcript that is provably not
  there, `11` is one that could not be read (or whose absence could not be established — the
  spend is UNKNOWN), and `12` is a transcript read in full that carries zero billed assistant
  turns. That third state is a real transcript a failed run writes, and reporting it as a
  measured zero would price a broken run as a free one.
- **It cannot block anything.** No threshold, no budget flag, and no exit code that varies
  with a spend magnitude — the no-gate ruling on epic #4779, asserted by a test that a
  very large total still exits `0` rather than left as a note here.

### The spend ledger

`spend read` prices one transcript on demand; the ledger is where measured runs *survive*
([#5009](https://github.com/kamp-us/phoenix/issues/5009)). A producer appends one **JSON Lines**
row per completed run to `.fabrika/spend-ledger.jsonl` (repo-relative, gitignored,
`--spend-ledger` overrides it) — each line carrying that run's spend and the identity of the work
it measured. **There is no in-repo producer today:** the eval runner was the only caller of
`appendSpendLedger` and went out with the eval tooling
([#5510](https://github.com/kamp-us/phoenix/issues/5510)), so `spend rollup` reads whatever an
operator or a future producer wrote and reports an empty ledger otherwise. The core is
[`src/spend/ledger.ts`](./src/spend/ledger.ts): `appendSpendLedger` writes, `readSpendLedger`
reads back the well-formed rows **and the count of lines it skipped**, so a truncated tail
costs one line rather than the file. Every line stamps its own `v`, which is the seam a later
row shape evolves through.

The module imports from `spend/` and `io/` only, so a reader of the ledger drags in nothing but
the meter.

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
- **Four refusals, none of them a zero.** `7` is no ledger at that path (nothing recorded yet), `11`
  is a ledger that could not be read (the spend is UNKNOWN), `12` is one read in full that yielded no
  rows at all, and `13` is a ledger that *does* hold rows where the given window selects none — an
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
status open                       # the composite five-field readout the skill injects
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
  cores, never by spawning a verb and reading its exit code. The fifth field, `lanes`, renders the
  `lane stale` sweep ([`src/lane/stale-verb.ts`](./src/lane/stale-verb.ts)) over both default roots
  at that verb's documented 60-minute threshold, so a dead operator's silent lane surfaces on every
  cold session without anyone typing the command (#5908): stale lanes are named with their ages,
  zero stale lanes — including zero lanes on disk — is the proven negative `empty`, and an
  unreadable root or lane record is `unknown` with its reason. It reports; it never resumes.
- **`7` and `11` are the pair.** `7` is an **explicitly passed** `--skills-dir` proven absent; `11`
  is a failed read. An *implicitly* resolved roster holding zero skills is neither — it is `empty`
  at exit `0`.

The roster resolves in four tiers — an explicit `--skills-dir`, the installed plugin's own skills
tree, `claude-plugins/fabrika/skills` in-repo, then that same path in the checkout the CLI itself
runs from — and prints which one served, `explicit` · `plugin` · `repo` · `checkout`
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
pnpm --filter @kampus/fabrika-cli typecheck   # tsc
pnpm --filter @kampus/fabrika-cli build       # tsc -> dist/, for the published tarball only
```

**The development loop has no build step.** `bin` points at `./src/bin.ts` and Node ≥ 24 strips the
types natively, so an edit to `src/` is live on the next invocation — which is the entire point of
the workspace `devDependencies` line in the root `package.json`. `build` emits `dist/` for the
published tarball and nothing else reads it; see [the two Node floors](#the-two-node-floors) for why
that `≥ 24` is this workspace's number and not the published package's. Emit and type-check now run
the same binary — the stable native `tsc` (ADR 0271) — so the published artifact and the gate can no
longer disagree about the compiler.

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

One raw `node:*` read survives, named by that pattern doc rather than overlooked. **fd 0** stays a
raw `node:fs` read at the boundary in [`src/io/stdin.ts`](./src/io/stdin.ts) — the standing ruling,
where `Stdio.stdin` is a considered-and-declined stream swap rather than a missing service; the
verbs take the read as an injected effect, so the `EAGAIN` and TTY paths stay testable without a
real descriptor.

The delegation layer reads `process` — `cwd()`, `argv`, `execPath`, `env`, `exit()` — and that is
confined to [`src/delegate/entry.ts`](./src/delegate/entry.ts), the boundary the bin bootstrap calls.
The walk and the decision it feeds are Effects over `FileSystem` / `Path` / `ChildProcessSpawner`,
so every branch — including "an ancestor could not be probed" and "the spawn faulted" — is driven by
substituted services rather than by a real tree.
