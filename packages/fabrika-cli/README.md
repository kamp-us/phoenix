# @kampus/fabrika-cli

The deterministic verb package [fabrika](../../claude-plugins/fabrika/) skills call.
`fabrika <group> <verb> …` dispatches to a registered verb group. Five groups are
registered: `adr`, the six verbs the `/adr` skill's derived contract specifies; `report`,
the three the `/report` contract specifies; `triage`, the intake-queue group the `/triage`
contract specifies; `eval`, the graded-corpus harness the fabrika eval layer measures
itself with; and `wire`, which owns the byte-level formats two skills meet through on a
GitHub artifact.

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

## The `wire` group

A **wire format** is the byte-level agreement two skills meet through on a GitHub artifact —
the acceptance-criteria block on a sub-issue body, the verdict marker on a PR. Each one is
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
