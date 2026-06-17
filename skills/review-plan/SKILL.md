---
name: review-plan
description: Verify a planned epic's ledger against the deterministic structural floor before its children become pickable — the plan-layer gate, the symmetric twin of review-code one stage earlier. Trigger on "review the plan for epic #N", "gate epic #N", "run review-plan", "verify the ledger for #N", "flip the planned children of #N", or whenever a plan-epic-output epic needs its `status:planned` children gated to `status:triaged`. This is the verification stage between plan-epic and write-code: it consumes the epic ledger plan-epic produced and produces a pass/fail verdict against the `epic-ledger` hard-defect floor — flipping `status:planned → status:triaged` on a clean ledger, posting a per-defect FAIL on a dirty one. The gate is portable: it resolves the in-repo `packages/epic-ledger` when present and falls back to the published `@kampus/epic-ledger` CLI otherwise (ADR 0064), so it runs in a foreign install too. It never repairs the ledger and never blocks the flip on a judgment call.
---

# review-plan

You are the **plan-layer gate**. `plan-epic` already turned a triaged epic into a
PRD-grade ledger: a brief, a `## Dependencies` topology, and linked sub-issues each
minted `status:planned` — **not** pickable by `write-code`. Your job is to verify that
ledger against the **deterministic structural floor** and, on a clean pass, flip every
child `status:planned → status:triaged` so `write-code` can pick them up. You are the
symmetric twin of [`review-code`](../review-code/SKILL.md), one stage earlier: where
`review-code` gates a PR against its acceptance criteria before merge, `review-plan`
gates an epic ledger against the floor before `write-code` starts.

Read ADR [0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md) — it is the binding spec
for this skill. The whole gate architecture (the flip *is* the enforcement, the floor
blocks and the soft-advisor never does, flag-don't-repair, converge-on-stall) is settled
there; this skill is its operating procedure.

## Authority limit: you flip, you never repair

**You mutate exactly two things: child labels (the flip, on a clean pass) and your own
verdict comment.** You never edit the brief, the `## Dependencies` topology, or a
sub-issue body to *fix* a defect — repair is the [re-plan convergence loop](#the-re-plan-convergence-loop)'s
job, which re-invokes `plan-epic` and re-runs you. A gate that also repairs the thing it
checks loses the independence that makes its verdict trustworthy — the same discipline
that stops `review-code` from merging (ADR 0047 Decision 3).

## The deterministic floor owns the decision; the soft-advisor never blocks

The pass/fail decision is **100% deterministic**: it is exactly the hard-defect set of
`epic-ledger`'s `validateLedger` — `MISSING_DEPS_SECTION`, `DEP_CYCLE`,
`DANGLING_DEP`, `ORPHAN_CHILD`, `MISSING_STORIES_SECTION`, `UNCOVERED_STORY`, `ZERO_AC`,
`MISSING_STORY`, `MISSING_LABEL`, `NEEDS_TRIAGE_LABEL`. An empty set flips; a non-empty set
blocks. (`MISSING_STORIES_SECTION` is the epic-level "no `### User stories` at all" defect —
the story-side mirror of `MISSING_DEPS_SECTION`; when it fires the per-child `MISSING_STORY`
is suppressed, so a story-less epic reads as one root-cause defect, not N child ones.
`DANGLING_DEP` fires only on a referenced issue that resolves to *nothing* — a real
cross-epic `requires:` edge is resolved at the GitHub boundary and allowed through.) The
**LLM soft-advisor** (acceptance-criteria checkability, brief-fidelity) produces *caveats
attached to a PASS* — it **never** changes the pass/fail decision (ADR 0047 Decision 2).
Floor-only blocks. This is the whole reason the gate exists: to replace a non-deterministic
LLM prose verdict with a stable one a re-plan loop can converge against.

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org's legacy Projects-classic integration breaks GraphQL issue queries.
Every read and write goes through `gh api` REST. The deterministic action does this for
you (it shells `gh api` through the `Github` capability); when you read context by hand,
use REST too.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every hand-run
`gh api` call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per
the shared contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## The formats contract

Your floor is the structural shape of the ledger — read the contract so you know what the
validator checks against: [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md).
The load-bearing pieces:

- **The `planned → triaged` flip** (§Pipeline labels) — `plan-epic` mints
  `status:planned`; **you own the flip to `status:triaged`** and nothing else does it.
- **`## Dependencies` grammar** (format 1) — the topology the floor checks for cycles,
  dangling edges, and orphans.
- **Sub-issue body** (format 2) — the `### Acceptance criteria` checklist (the `ZERO_AC`
  floor + the soft-advisor's checkability read) and the `**Stories:**` line (the
  story-coverage floor).

## Acquire the epic-lock before you flip or re-plan — release it on every exit

You own the `planned → triaged` flip; `plan-epic` owns supersede/unlink/close on re-plan.
Run concurrently on one epic they interleave: a re-plan supersedes child C at the same
instant your gate flips C `triaged` (pickable), and `write-code` picks a story the plan just
dropped (#264, race X3). So **before the gate's first flip and before the convergence loop's
first `rePlan`, acquire the `status:planning` epic-lock; release it when you reach PASS or
park, on every exit path including failure** (ADR
[0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md)).

**Acquire (one bash step, fails closed).** Re-read the lock label; if it's held, back off and
stop — don't flip, don't loop. Otherwise `POST` it — and **only treat the lock as acquired if
that `POST` actually succeeds**. A failed acquire (the 422 returned when `status:planning` hasn't
been created in the repo — it's a canonical lock label, see ADR
[0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md) §Setup and the formats doc's status-label table
— or any transient `gh` IO fault) must **not** fall through to the gate flip: it backs off and
exits 0, so a missing label or a flaky write never lets you flip unlocked. **The back-off `exit 0`
is deliberate** (a held lock or a setup gap is not a review-plan *failure*) — but it shares the
exit code of a clean PASS, so a caller keying on exit status alone cannot tell "gated" from
"backed off, did nothing"; the echo is the signal, so a wrapper must read it (or re-run) rather
than treat `exit 0` as "the epic was gated".

```bash
# acquire: defer to a lock already held; otherwise POST it — and proceed ONLY if the POST succeeds
HELD=$(gh api repos/$REPO/issues/<EPIC> --jq '[.labels[].name] | index("status:planning")')
# gh --jq prints "" (not "null") for a jq null, so test non-empty: index() is a numeric position when held, empty when absent.
if [ -n "$HELD" ]; then
  echo "epic #<EPIC> is being planned by another run (status:planning held) — DO NOT flip, DO NOT loop."
  exit 0   # the held lock is the holder's, not ours — do NOT release it. Re-run later.
fi
if ! gh api repos/$REPO/issues/<EPIC>/labels -f "labels[]=status:planning" >/dev/null; then
  echo "could not acquire status:planning on epic #<EPIC> (422 missing label? transient gh fault?) — DO NOT flip, DO NOT loop."
  exit 0   # FAILS CLOSED: the POST didn't land, so we DON'T hold the lock — never flip/loop unlocked.
fi
# Lock held. WE acquired it, so WE must release it — on EVERY terminal path (below).
```

**Release is an explicit agent step, not a shell `trap … EXIT`.** The acquire above runs in
*one* bash invocation; the gate flip (Step 1) and the convergence loop's `rePlan` calls run in
*separate later* bash invocations — each its own process. A `trap … EXIT` armed in the acquire
shell fires the instant *that* shell exits, i.e. **before the gate or loop ever runs**, releasing
the lock immediately and giving you zero serialization. So the release can't live in the acquire
snippet; it is an action **you** take, deliberately, on the way out — run this exact `DELETE` once
you reach **any** terminal state (PASS-and-flipped, parked, or a fault mid-flight):

```bash
# release: run on EVERY exit path AFTER a successful acquire (PASS/flip, park, or fault mid-flight).
# Do NOT fire-and-forget — a silently-failed DELETE LEAKS the lock and wedges the epic, the exact
# catastrophe this design prevents. A 404 is benign (label already gone — released, or never
# landed); ANY other failure means the lock may still be held, so surface it LOUDLY.
if ! relerr=$(gh api -X DELETE repos/$REPO/issues/<EPIC>/labels/status:planning 2>&1); then
  case "$relerr" in
    *"HTTP 404"*|*"Label does not exist"*) : ;;  # already released / never acquired — nothing to free
    *) echo "WARNING: failed to release status:planning on epic #<EPIC> — the epic-lock may be LEAKED (still held). Re-run this DELETE or clear the label by hand; until cleared, plan-epic/review-plan back off on this epic. ($relerr)" ;;
  esac
fi
```

The release fires on **every** terminal path on purpose: the gate and the convergence loop can
raise (a RePlanError, a gh IO fault, an aborted agent), and the convergence loop in particular
can fail mid-flight, so this is not hypothetical. As an LLM agent you must still issue the
`DELETE` before you stop on those paths — a release that fires only on the clean
PASS-and-flipped-or-parked fall-through LEAKS the lock on the raise path (wedging the epic against
every later plan-epic/review-plan run until a human clears it — #264). **Only release a lock YOU
acquired** (the success branch above), never the held lock you backed off from. A leaked lock is
silent and only a human clears it.

`POST .../labels` is **not** compare-and-swap (no `If-Match`), so this is
**detect-and-serialize, not a mutex** (the §7/#260 TOCTOU over the whole child set): it
serializes the *common* flip-vs-supersede interleaving, and the residual is backstopped by
plan-epic's epic-body splice+recheck (#261) and the convergence loop's signature checkpoint
(below). Don't claim a guarantee the label API can't give. **Holding the lock is also what
makes "two convergence loops on one epic" unrepresentable** (#264, race X4): a second
`review-plan` finds the lock held and backs off before its first `rePlan`, so only one loop
ever drives an epic.

---

## Step 1 — Run the deterministic gate action

The gate action is built: `epic-ledger`'s `runGate(epicNumber)` (`packages/epic-ledger/src/gate.ts`).
Given an epic number it fetches the `EpicLedger` via the `Github` capability, runs
`validateLedger`, and on a **clean** ledger flips every `status:planned` child to
`status:triaged` and posts a PASS verdict; on **≥1 hard defect** it posts a per-defect
FAIL verdict and flips **nothing**. It returns a structured `GateVerdict`
(`{_tag: "pass", flipped}` or `{_tag: "fail", defects, signature}`).

Invoke it through the package's CLI (the `bin.ts` entry, wired over `NodeRuntime.runMain` +
`NodeServices.layer` — you run the binary, you don't re-implement the floor in prose). Which
binary — the in-repo `packages/epic-ledger/src/bin.ts` or the published `@kampus/epic-ledger`
CLI — is resolved by the block just below; either way the floor is identical.

**Resolve the gate binary — in-repo first, published fallback (ADR
[0064](https://github.com/kamp-us/phoenix/blob/main/.decisions/0064-epic-ledger-npm-publish-automated-release.md)).**
`review-plan` is **portable**: the same `epic-ledger` floor runs whether or not the plugin
is installed in phoenix. The gate dependency resolves **in-repo first, published fallback** —
prefer the on-disk `packages/epic-ledger/src/bin.ts` when it exists (phoenix-local: no
network, no published-artifact dependency on the daily pipeline), and otherwise invoke the
**published** `@kampus/epic-ledger` CLI via `pnpm dlx`. Build the invocation once into a
`$GATE` command and use it everywhere below, so there is exactly one resolution site:

```bash
# resolve the gate command once — in-repo-first, published-fallback (ADR 0064)
if [ -f packages/epic-ledger/src/bin.ts ]; then
  GATE="node packages/epic-ledger/src/bin.ts"          # phoenix-local: run the in-repo bin directly
else
  # foreign install: run the PUBLISHED CLI. Version tracks the in-repo package (ADR 0064 §3):
  # the published version is authoritative-by-package.json, and a gate-logic change bumps it +
  # cuts a matching epic-ledger-v* release in the same change, so `@latest` is the version that
  # mirrors the current source. Pin a concrete `@<version>` only to reproduce an older verdict.
  GATE="pnpm dlx @kampus/epic-ledger@latest"
fi
```

Either branch yields a runnable `$GATE`, so a foreign install **runs** the gate rather than
degrading — and no raw `ERR_MODULE_NOT_FOUND` can surface, because the in-repo branch is only
taken when the bin is on disk and the fallback fetches the published package before running.
Then run the gate through `$GATE`:

```bash
# from the repo root:
$GATE <EPIC>            # the live gate — flips + comments
$GATE <EPIC> --dry-run  # read-only: validate + print, no mutation
# phoenix-local equivalent via the workspace script:  pnpm --filter @kampus/epic-ledger gate <EPIC>
```

`runGate(<EPIC>)` is the underlying action the CLI calls (`epic-ledger`'s `runGate`,
`packages/epic-ledger/src/gate.ts`). Use `--dry-run` first when you want to see the verdict
before any label moves; the bare form is the real gate. Both fetch the *current* ledger live,
so a re-run after a re-plan picks up the new structure.

This is the **whole pass/fail decision**. Do not re-derive defects by reading the ledger
yourself — the validator is the single source of truth, and re-judging it in prose
reintroduces exactly the non-determinism this gate removes. The action's verdict *is* the
gate's verdict.

- **`pass`** → every `status:planned` child is now `status:triaged` (pickable), and a PASS
  verdict comment is on the epic. Go to Step 2 (the soft-advisor) to *annotate* that pass.
- **`fail`** → a FAIL verdict listing each defect is on the epic; **no child was flipped**.
  Skip Step 2 (the soft-advisor only annotates a PASS — there's nothing to annotate on a
  FAIL) and go to [the convergence loop](#the-re-plan-convergence-loop).

---

## Step 2 — Run the LLM soft-advisor (caveats-only, on a PASS)

Only on a **PASS**. The floor confirmed the ledger is *structurally* sound; the
soft-advisor reads it for the **judgment-shaped** quality the floor can't decide. It
produces **advisory caveats**, never a verdict. Two reads:

- **AC-checkability** — for each child's `### Acceptance criteria`: is every criterion
  *verifiable from outside*, the way `review-code` will have to verify it? Flag a criterion
  that's vague ("works well", "is robust"), implementation-coupled ("uses a `Map`"), or
  un-observable. The floor only counts that ≥1 criterion *exists* (`ZERO_AC`); checkability
  is the judgment on top.
- **Brief-fidelity** — does the plan still serve the epic's brief, without inventing scope
  the brief never asked for or dropping a brief requirement no child covers? The floor
  checks story *coverage* structurally (`UNCOVERED_STORY`/`MISSING_STORY`); fidelity is
  whether the stories themselves still faithfully decompose the brief.

**The soft-advisor is YOU, the agent, reading the ledger** — not a second program. That is
the deliberate design (see [Design: the soft-advisor's form](#design-the-soft-advisors-form)):
the deterministic floor is code (`validateLedger`) precisely because it must be identical
every run; the soft signal is *inherently* a judgment call, so it lives where judgment
lives — in the agent running this skill, grounded in the ledger it just read. You do not
write a new validator for it; you read and annotate.

**These caveats NEVER block the flip.** The flip already happened in Step 1 on the clean
floor. The soft-advisor cannot un-flip a child, cannot turn a PASS into a FAIL, cannot gate
on a vague AC. If the ledger is structurally clean, the children are pickable — full stop.
A caveat is a *note to the humans and the next agents*, surfaced so a weak-but-valid plan
gets sharpened, not stalled.

Append the caveats to the PASS verdict as an advisory section (edit your verdict comment,
or post a follow-up comment on the epic):

```markdown
**Advisory caveats (non-blocking — the flip stands):**
- AC-checkability — #<child>: "<criterion>" is not externally checkable; suggest "<sharper form>".
- Brief-fidelity — story <n> ("<story>") has drifted from the brief's "<requirement>"; consider re-scoping.
```

If the soft-advisor finds nothing, say so (`No advisory caveats — the plan reads clean.`)
— a clean soft read is a real signal, not an omission.

### Route an in-scope soft-advisor finding by appending a child AC (ADR 0079)

The soft-advisor's reads are the plan-layer call site of the **specialist fan-out +
route-don't-grade** mechanism — defined once in
[`review-code`'s shared reference](../review-code/SKILL.md#specialist-fan-out--route-dont-grade-adr-0079--the-shared-reference)
(ADR [0079](https://github.com/kamp-us/phoenix/blob/main/.decisions/0079-reviewer-authored-acceptance-criteria.md)
§1–§2), with the append shape + provenance tag + four fences in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §2. **Cite them; do not
re-derive the route decision, the tag fields, or the fences here.** But `review-plan` fits
the mechanism **only in this soft-advisor lane**, never in the deterministic floor — the floor
is byte-identical code whose pass/fail must stay non-derived (Step 1), so it neither fans out
nor appends. Two adaptations the plan layer forces:

- **The append target is the *child* sub-issue, not the gated artifact.** `review-plan` gates
  an epic ledger, but the AC list lives on each **child** — and the children are exactly what
  the flip makes pickable. So an appended criterion lands on the **specific child** the finding
  traces to (its `### Acceptance criteria` list), provenance-tagged
  `<!-- ac:review-plan pr:#<child> round:K -->` (here `pr:#<child>` names the child issue the
  AC was added to — `review-plan` has no PR). `write-code` drains it on that child like any
  other `[FAIL]` row.
- **It never blocks — the soft-advisor invariant is sovereign.** Appending a child AC is a
  *route*, not a verdict: it can no more un-flip a child or turn the PASS into a FAIL than any
  other caveat (the children already flipped on the clean floor in Step 1). The route is the
  caveat's *machine-actionable* form — instead of only a prose "sharpen this AC" note, an
  **in-scope** finding (one that traces to the child's stated story/goal — the §2 in-scope-only
  fence, the same trace test) is written as a concrete new criterion the loop drains.

Route each soft finding:
- **In-scope** — traces to the child's stated story/goal → **append a new AC to that child**
  via the §2 surface (tag `ac:review-plan`), *and* keep the prose caveat. Subject to all four
  §2 fences (append-only · in-scope-only · ACL-gated/fail-closed · frozen-after-round-K).
- **Out-of-scope** — a real defect that doesn't trace to any child's story (a gap the brief
  itself has, an adjacent concern) → file it via [`report`](../report/SKILL.md); it does
  **not** append to a child and does **not** affect the flip.

**Floor untouched:** this routing runs only on a Step-1 PASS, only in the soft-advisor lane,
and changes nothing about the deterministic decision, the `planned → triaged` flip, or the
"caveats never block" invariant — it is additive, exactly as the fan-out is additive in the
other three gates.

### Worked example — PASS with caveats

Epic #240's ledger is structurally clean: deps present, no cycle, every child has ≥1 AC, a
`**Stories:**` line, and a full label set; every declared story is covered. **`runGate`
returns `pass` and flips #241, #242, #243 to `status:triaged`.** The soft-advisor then
reads:

- #241's AC "the importer is reliable" — **not externally checkable** (caveat: suggest "the
  importer retries a failed row up to 3× and surfaces a `RowImportError` after").
- Story 4 ("as an admin, I want an audit log") — the brief never mentions auditing
  (caveat: brief-fidelity drift; either drop story 4 or point at the brief line that
  motivates it).

The verdict is **still PASS, the children are still flipped and pickable.** The two caveats
ride along so a human (or a follow-up `plan-epic` run) can sharpen #241's AC and resolve
the story-4 drift — but `write-code` is free to pick #241/#242/#243 right now. **A
soft caveat never costs the pipeline a flip.** That is the invariant this whole skill is
built to hold.

---

## The re-plan convergence loop

On a **FAIL**, the ledger has hard defects and nothing flipped. Repair is **not** your job
(you don't hand-edit a ledger). Instead, drive the **re-plan convergence loop**
(`epic-ledger`'s `runConvergenceLoop(epicNumber)`, `packages/epic-ledger/src/loop.ts`):

1. **Re-invoke `plan-epic` on the epic** (through the `RePlanner` capability — see below),
   then **re-run the gate**.
2. **Repeat while the hard-defect set strictly shrinks.** Each pass's defect set must be
   strictly smaller than the last; convergence to zero ends in a clean PASS (children
   flipped).
3. **Park on a stall — keyed on the ledger *signature*, not the defect count.** The loop
   compares each pass against the last by the gate's run-stable `ledgerSignature` (the
   content hash), not just the defect *count*. If the signature **repeats** (a cycle — the
   same ledger came back) it parks; the count check (defects fail to shrink) is a secondary
   stop, never the primary convergence signal. This is load-bearing under concurrency: a
   count-only check could declare convergence on a ledger a concurrent run mutated — two runs
   landing on the same count over different content (#264, race X4). Keying on the signature
   means the stall test is **content-keyed, not count-keyed**: the loop parks on a *repeated*
   signature (a cycle) rather than declaring convergence on a count two runs happened to share.
   (It does not abort on arbitrary mid-loop drift — a *different* signature reads as progress;
   `loop.ts` parks only on a repeat. The epic-lock above is what stops a concurrent mutator
   from drifting the ledger out from under the loop in the first place.) (The
   epic-lock above is the primary defense — it stops two loops from running at all; the
   signature checkpoint is the in-loop backstop for the lock's residual window. ADR
   [0059](https://github.com/kamp-us/phoenix/blob/main/.decisions/0059-epic-plan-lock.md).) Park the epic `status:needs-info` with
   a diagnostic naming the unresolved defects. Convergence is the stop condition; a high flat
   ceiling (`DEFAULT_CEILING`) is only a runaway backstop, expressed as a `Schedule` (ADR 0047
   Decision 3).

The loop owns the repeat/stall control flow; you provide the two capabilities it composes:
the `Github` capability (the same one `runGate` uses) and a `RePlanner` whose `rePlan`
re-invokes `plan-epic`.

### Wiring `RePlanner` to the `plan-epic` skill

`plan-epic` is a **skill/agent, not a function** the package can import — so the loop
depends on a `RePlanner` `Context.Service` (a one-method seam, `rePlan(epicNumber)`) that
*you* satisfy at the call site. Bind it to however you actually re-invoke `plan-epic`:
spawn a `plan-epic` subagent on the epic and resolve `rePlan` when it returns; or shell out
to the plan-epic runner; or enqueue a job and await it. The package owns convergence; the
binding to the real agent lives here, in this skill, outside the package (see
[Design: re-invoking plan-epic](#design-re-invoking-plan-epic)).

```
// at the review-plan call site (pseudocode for the capability wiring)
RePlanner = { rePlan: (epic) => <spawn a plan-epic agent on `epic`, resolve on completion> }
runConvergenceLoop(<EPIC>)  // provided Github + RePlanner — re-plans on FAIL, parks on stall
```

A `parked` outcome is terminal for this invocation: the epic sits `status:needs-info` with
its diagnostic, waiting on a human or a different plan. A `converged` outcome means the
children flipped — run the soft-advisor (Step 2) over the now-clean ledger to annotate the
pass.

---

## Design choices (the two ambiguous parts, recorded)

These two are the parts ADR 0047 left to the implementer; recording them here so the next
agent inherits the rationale rather than re-deriving it.

### Design: the soft-advisor's form

**Choice: the soft-advisor is the agent running this skill, reading the ledger in prose —
not a second program, not an LLM call baked into `epic-ledger`.** Rationale: ADR
0047 Decision 2 draws the line at *determinism* — the floor is code because it must be
byte-identical every run; the soft signal is *inherently* a judgment that an LLM cannot
render identically twice, so encoding it as a package function would falsely imply
stability and tempt a future caller to gate on it. Keeping it as the skill-agent's read (a)
keeps the package purely deterministic (its tests stay exact), (b) puts the judgment where
judgment already lives in this pipeline (the agent), and (c) makes "caveats never block"
structural: the package's `runGate` already flipped on the clean floor *before* the agent
ever reads for caveats, so there is no code path by which a caveat could un-flip. The
alternative — an `llm-advisor.ts` in the package — was rejected: it would either call a
model (non-deterministic code masquerading as deterministic) or be a stub, and either way
it invites the "block on soft signal" mistake the ADR bans.

### Design: re-invoking plan-epic

**Choice: a `RePlanner` `Context.Service` seam the call site binds to a `plan-epic`
agent-spawn, not a direct function call.** Rationale: `plan-epic` is a skill (an LLM agent
with GitHub side effects), not an importable function — `epic-ledger` cannot and
should not depend on it. Modeling re-plan as a one-method capability (`rePlan(epicNumber)`)
lets the package own the *convergence control flow* (the shrink/stall/park `Schedule`
logic, fully unit-tested with a faked `RePlanner`) while the *binding to the real agent*
lives in this skill, at the call site, where agent-spawning is available. This is the same
capability-at-the-boundary discipline the `Github` service already uses for `gh`. The
alternative — the package shelling out to a `plan-epic` CLI — was rejected: it would hard-
wire a runner the repo doesn't define (the orchestrator is deliberately out-of-repo, ADR
0046) and make the loop untestable without spawning a real agent.

---

## Running it

A single invocation gates one epic: acquire the `status:planning` epic-lock (see [§Acquire
the epic-lock](#acquire-the-epic-lock-before-you-flip-or-re-plan--release-it-on-every-exit)),
then run the deterministic action (Step 1) — on a PASS the children are flipped and you
annotate with the soft-advisor (Step 2), routing each in-scope soft finding by appending an AC
to the child it traces to (out-of-scope → `report`, ADR 0079 — soft-advisor lane only, the
floor and the never-block invariant untouched); on a FAIL nothing flipped and you drive the
convergence loop (re-plan + re-verify while shrinking, park on stall). **Release the lock on
every exit — PASS-and-flipped, parked, or failure;** a lock left held wedges the epic against
every later `plan-epic`/`review-plan` run. Report back a short ledger: the epic, the verdict (pass+flipped children, or
fail+defects), any advisory caveats, and — if the loop ran — its terminal outcome
(converged after N re-plans, or parked on which defects). Don't narrate every REST call —
the verdict comment and the child labels are the durable record.

The gate is **stateless**: re-invoking it re-fetches the current ledger and re-derives the
verdict, so a re-run after a re-plan naturally picks up the new structure. That
statelessness is what lets the convergence loop re-run it safely.

## Conventions

This skill is one of a suite (`report` → `triage` → `plan-epic` → **`review-plan`** →
`write-code` → `review-code`) that turns GitHub issues into an agent-operable pipeline. The
shared label semantics and the body/comment/dependency/story formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md); the gate architecture is
ADR [0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md); the deterministic floor, the gate
action, and the convergence loop are the `epic-ledger` package (`packages/epic-ledger`,
published as `@kampus/epic-ledger` — ADR 0064). Your
input is a `plan-epic`-output epic whose children are `status:planned`; your output — the
`planned → triaged` flip on a clean ledger (or a parked epic on an unfixable one), plus the
verdict and any advisory caveats — is what makes `write-code`'s existing `status:triaged`
pick predicate enforce the gate for free. You are the symmetric twin of `review-code`: the
two gates bracket `write-code` on both sides — the plan it consumes is floor-verified going
in, the PR it produces is AC-verified going out.

### Distribution — portable via the published gate (ADR 0064)

When the suite ships as an installable plugin, `review-plan` is **repo-agnostic like every
other skill** — there is no longer a single phoenix-pinned exception. Its deterministic gate
is the `epic-ledger` floor, resolved **in-repo first, published fallback** (Step 1): phoenix
runs the on-disk `packages/epic-ledger` bin, and a foreign install runs the published
`@kampus/epic-ledger` CLI via `pnpm dlx`. So a non-phoenix install **runs** the gate instead
of degrading. The published version tracks the in-repo source (a gate-logic change bumps the
`package.json` version and cuts a matching `epic-ledger-v*` release in the same change), so
both worlds gate against the same floor. See ADR
[0064](https://github.com/kamp-us/phoenix/blob/main/.decisions/0064-epic-ledger-npm-publish-automated-release.md),
which **supersedes ADR [0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md) §3**
(the phoenix-pinned / degrade-with-a-message deferral) and lands the npm-publish follow-up epic
[#362](https://github.com/kamp-us/phoenix/issues/362).
