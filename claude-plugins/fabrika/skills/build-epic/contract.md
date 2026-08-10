# `/build-epic` — derived CLI contract

**Skill:** [`build-epic`](SKILL.md) · **Authoring brief:** [#4950](https://github.com/kamp-us/phoenix/issues/4950) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`epic`** subcommand group (the skill is the
build family's epic conductor; the group literal stays unhyphenated so every fence reads `fabrika
epic <verb> …`), registered in `packages/fabrika-cli/src/registry.ts` like the shipped groups,
every leaf declared via `leafCommand` (`src/excess-operand.ts` — a bare `Command.make` silently
opts out of the excess-operand guard). The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). The v1
machinery named below — `.claude/workflows/drive-issue.js` and, under
`packages/pipeline-cli/src/tools/`, `drive-issue-flow/`, `resume-policy/`, `epic-ledger/`,
`epic-splice/`, `run-evidence/` — is prior art **read** for semantics and scars; none is invoked,
wrapped, or deferred to. Every v1 module name cited anywhere in this spec (including inside the
ledger and counter sections) is **non-normative**: the behavior it informs is restated here in
full, and an implementer needs none of those files to build these verbs.

**What fabrika already ships, reused — never respecified.** Lane mechanics are the **`build`
group's, reused as landed verbs** ([`build`'s contract](../build/contract.md)) — the cross-contract
shape `build-ui` sanctioned: the conductor claims the epic with `build claim`/`confirm`/`release`,
proves ground with `build tree`, cuts and resumes the one branch with `build branch`, validates a
slice with `build check`, publishes with `build push`, opens the PR with `build pr`, and posts
progress with `build note`. The `build` contract owns those verbs' behavior; nothing here
respecifies them. Modules reused by import:

- `packages/fabrika-cli/src/wire/verdict-marker.ts` — `emit` / `read` / `headSha` / `bindToHead`
  and the branded 7–40-hex `HeadSha`. **Entirely pure — it binds to any SHA string, pushed or
  not**, which is what makes an unpushed-slice verdict specifiable at all. `epic verdict` and
  `epic status` import it.
- `packages/fabrika-cli/src/wire/acceptance-criteria.ts` — the total three-armed read
  (`Found`/`Absent`/`Malformed`). `epic open` imports it per slice contract; `build-epic` is
  already a declared **producer** of this format (`src/wire/registry.ts`).
- `packages/fabrika-cli/src/build/git.ts` — `headSha`, `isAncestor`, `mergeBase`, `changedFiles`.
  `epic landed` and `epic slice-diff` import them.
- `packages/fabrika-cli/src/build/lane-guard.ts` + `src/build/worktree.ts` — the shared
  tree/lane/claim preconditions and their codes (`12`/`14`/`15`/`11`). Every mutating `epic` verb
  runs them, identically to `build`'s own verbs.
- `packages/fabrika-cli/src/build/dependencies.ts` — the canonical `## Dependencies` grammar
  (defined in `build eligible`'s block). `epic open` imports the parser; this spec adds **no
  second grammar**.
- `packages/fabrika-cli/src/eval/spawn.ts` — `NO_MODEL_TURNS_SIGNALS` / `noModelTurns` /
  `classifyRun`: the measured silent-green taxonomy (an unresolvable skill exits 0 with zero
  turns). `epic record --event dispatch-dead` consumes its classification vocabulary; the
  taxonomy is imported, never re-derived.
- `packages/fabrika-cli/src/report/leaks.ts` (`scanBody`, `isBareAtReference`) and
  `src/report/compose.ts` (`normalizeForReadback` — three steps; read the body, the docblock
  understates it). The posting-shaped verbs import both.

A restatement of any of these would be a transcription, and a transcription drifts. The spec says
*import this*, with the path.

**Considered and deliberately not derived** — each already enforced or owned elsewhere
(interface convention rule 6; conventions §7 homes these in `.out-of-scope/`, unbootstrapped —
tracked inline as the sibling contracts do):

- **A plan validator.** The planning lane's gate (`check-epic-plan`, #4948) owns structural
  ledger soundness. `epic open` refuses an *unparseable* topology (it cannot conduct what it
  cannot read) but computes no second verdict on plan *quality*.
- **An epic-done detector.** `epic-autoclose.yml` closes the epic off native sub-issue state.
  The conductor expects it; no verb re-answers it.
- **An epic-body writer.** The conductor writes no plan state back to the epic body — the run
  ledger is the run's state, and body splicing (with its #261/#4599 round-trip scars) stays the
  planning lane's. Progress lands as `build note` comments.
- **A CI reader, a §CP classifier, a leak scanner over changed files.** `build`'s and `review`'s
  contracts already record why each is nothing here too.
- **A worktree provisioner.** `build tree` verifies and never provisions; under the #4934 ruling
  the conductor's spawner provisions ONE epic worktree and every subagent runs inside it. No verb
  creates, locks, or reaps trees (`worktree.ts`: the spawner owns the lifecycle).
- **A retry classifier.** The crash-vs-healthy axes are the ledger's two counters (below); the
  TRANSIENT/LOGIC *classification* of a crash is the harness's, composed not reimplemented
  (`resume-policy.ts`: LOGIC includes every default-deny).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `epic open` | open or resume the run: parse the epic's slice topology, create the nonce-keyed run ledger if absent, print run state | fetch + registered parses + a keyed file create — no judgment; *whether to conduct* stays in the skill |
| `epic next` | the state relay: fold ledger + git graph into exactly one next action, retry breakers enforced | a deterministic fold over recorded events and derivable git facts; *composing the dispatch* stays in the skill |
| `epic record` | append one closed-vocabulary event to the run ledger, append-only, read back | a guarded append with an enum — no judgment |
| `epic brief` | the dispatch brief for one slice: contract, tree, branch, handoff path — emitted through the `slice-handoff` wire format | deterministic composition from ledger + slice contract; the *instructional content* is fixed by the format, not authored per run |
| `epic landed` | prove a slice's commit landed: HEAD advanced, clean tree, descendant of the slice's opening SHA | three git-derivable assertions; *what to do about a dead dispatch* stays in the skill |
| `epic slice-diff` | the unpushed commit's diff bytes, served from the local object store with the parent named | a local `git` read — no judgment; reading the diff is the evaluator's whole job |
| `epic verdict` | record one slice verdict bound to the local commit SHA, into the ledger, read back | marker composition via the wire module + a guarded append; the polarity is the evaluator's judgment, taken as input |
| `epic status` | the whole run folded: per-slice state, verdict bindings against the live graph, counters | a read-only fold; *reporting terminals* stays in the skill |

**Considered and not derived: a slice selector separate from `next`.** #4920 left open whether
the eligibility question belongs to `build`'s picker or this conductor. The shipped `build
eligible` now owns issue-level eligibility (its block defines the canonical `## Dependencies`
grammar); slice-level ordering *within* a run is `epic next`'s fold over the same imported
topology. The fork is resolved by reuse, not by a second verb — recorded here so it is not
re-derived.

## The run ledger — storage, shape, and the Q1 seam

**Storage (binds the implementation):** an append-only JSONL event log at
`<epic-worktree-root>/.fabrika-epic/<epic>-<claim-nonce>/ledger.jsonl` — **worktree-resident and
claim-nonce-keyed, never session-keyed** (#4516: the session key is constant across sibling
subagents, and a write collision is invisible to the victim) and **never committed** (the path is
covered by the git exclude mechanism at `epic open`; conductor state inside the epic's PR would
be scope leakage). Files and git are H2's only carriers, and the ledger rides the first.

**Shape (the Q1 proposal — the open question's seam, not its answer):** events, with state
**derived at read time** by `next`/`status`, never stored — the `ruled-keeps.ts` idiom, and what
keeps a wording change from perturbing resumability (`epic-ledger`'s `validate.ts` signature
discipline). Each line: `{"seq", "at", "event", "slice", "detail", "sha"}` (`sha` self-captured by the writer
on `slice-dispatched`/`slice-landed`, null elsewhere — see `epic record`) with `event` drawn from the
closed set `run-opened` · `slice-dispatched` · `dispatch-dead` · `slice-landed` ·
`verdict-recorded` · `retry-injected` · `breaker-tripped` · `pr-opened` · `run-halted`. A
readable ledger holding any event outside that set, a broken JSON line, or a `seq` regression is
**unnameable state — exit `21`, refuse, never guess**: a run in a state the model of the run
cannot name is how a conductor strands it (#4145, #3929, #4555). An *unreadable* ledger (I/O) is
`11`. Q1 (event log vs state machine) stays open on #4891; falsification lands here as a new
derivation in `next`, with the event log as its input — which is why the log stores no derived
state.

**Two counters per slice, never summed** (`resume-cap.ts` / `resume-policy.ts`, ADR 0130): the
**fail axis** counts `verdict-recorded(FAIL)`→`retry-injected` cycles, cap **2**; the **dead
axis** counts `dispatch-dead` events, cap **2**. Either cap reached makes `next` answer
`escalate-slice` (and `record` accept only `breaker-tripped`/`run-halted` for that slice). The
caps are constants in the `epic` group's `codes.ts`-sibling module, exported and named in
`--help` — a number a verb enforces, not a judgment (H4). A corrupt *counter derivation input*
cannot occur by construction (counters are derived from well-formed events; a malformed event is
already `21` — the `resume-policy.ts` NaN hole is unrepresentable here).

## Shared conventions

Every `epic` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries the answer only — JSON objects with named keys,
  except where a verb's block declares another byte shape (`epic brief`'s wire-format document,
  `epic slice-diff`'s diff bytes). Scope lines, refusal reasons, notices go to stderr. A non-zero exit prints nothing on stdout
  (`src/verb.ts`'s refuse shape).
- **Common inputs.** `--repo <owner/name>` (default: resolved from the `origin` remote) on the
  verbs that read GitHub (`open`, `brief` — `status` reads only the ledger and the local graph).
  GitHub access per
  [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql),
  paginated in full.
- **The content gate.** Every externally-authorable byte a verb returns — the epic body, slice
  contracts, child issue bodies — passes the `build` group's shared content-gate module before
  stdout, so the open #4859 posture lands as the same one module change. No verb caches content
  across invocations; every invocation re-fetches and re-gates (the TOCTOU answer for a branch
  held across many dispatches).
- **Preconditions are `build`'s, guarded identically.** Every verb that reads or mutates run
  state runs the imported lane guard (linked worktree `12`, lane branch `14`, claim held
  `15`/`11`) — the conductor's claim is on the **epic** number, and the lane branch is the one
  `build branch <epic>` cut. Two stated exemptions: `epic slice-diff` runs the tree assertions
  only (an evaluator holds no claim; it reads), and `epic open` runs tree + claim only
  (`12`/`15`/`11`, never `14`) — it precedes `build branch` in the loop, so the lane branch may
  not exist yet.
- **Error-message prefix** is the invoked verb's name, contract-wide, as in `build`.
- **A non-zero exit is UNKNOWN** to the caller until the code is read.

### The shared exit matrix

This matrix owns `code → meaning`; per-verb tables enumerate only that verb's own reachable
proven outcomes with triggers. `0`, `1`, `2`, `127` are the interface convention's reserved codes
(`src/verb.ts`, the exit-2 bootstrap in `src/bin.ts`), stated only here; every verb can return
them.

**Alignment:** `3`–`11` are `report`'s seats, imported (`src/report/codes.ts`), code-for-code as
`build` does, and the group registers those base seats in `ALIGNED_GROUPS`
(`src/exit-code-alignment.ts` — its checker verifies only the overlap with the `report` base).
**`12`–`19` are imported from `build`'s `codes.ts` verbatim** — this group runs the same
worktree, lane, claim, validation and push facts, and a caller driving `build` and `epic` in one
sweep must read one meaning per code; that identity is carried by the constant import itself,
which the alignment registry does not (and cannot) check — stated so an implementer does not
hunt for a `12`–`19` seat-map mechanism that does not exist. **`20`+ are this group's own** —
the genuinely-new facts; they carry no cross-group obligation.

| Code | Meaning |
|---|---|
| `0` | the answer is on stdout |
| `1` | usage error, or the verb failed to run |
| `2` | no implementation could be resolved (`src/bin.ts`) |
| `3` | stdin was read and held nothing |
| `4` | a required section is missing, malformed, empty, or out of place — in a document a verb derives from |
| `7` | zero scope: the target is proven absent (404) or closed, or there is nothing to judge |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the write landed but the read-back does not match |
| `10` | a value off its closed vocabulary — a semantic refusal, never a malformed-flag usage error |
| `11` | a required read failed — nothing was written, no outcome is proven |
| `12` | proven: not in a linked worktree (imported from `build`) |
| `13` | proven: the tree is dirty (imported from `build`; reached here at `epic landed`, whose block states the trigger widening — dirty beside the new HEAD, not only at a `--require-clean` open) |
| `14` | proven: the checked-out branch is not this lane's (imported) |
| `15` | proven: this session does not hold the claim (imported) |
| `18` | proven: this tree's validation is red (imported; reachable only through the reused `build check`) |
| `20` | proven: no run ledger exists for this epic + claim nonce — `epic open` has not run in this lane |
| `21` | refused: the ledger is readable but holds unnameable state — an off-enum event, a broken line, a `seq` regression; the run needs a human, never a guess |
| `22` | proven: no new commit landed for the slice — HEAD unchanged since the slice's opening SHA (a dead dispatch is a fact, distinct from a failed slice) |
| `23` | proven: a retry breaker is tripped for the slice — fail axis or dead axis at cap; the axis is named on stderr |
| `24` | proven: the named commit is not in this branch's local graph — nothing to diff, bind, or verify against |

`5`, `6`, `16`, `17`, `19` are seats no `epic` verb reaches, for two distinct reasons: `5`/`6`
are the authored-text leak codes, and no `epic` verb authors prose to a public surface (`verdict`
bodies land in the ledger; posting goes through `build note`/`build pr`, which own them); `16`,
`17`, `19` are owned by the reused `build` verbs (`eligible`, `push`) and reachable only through
them. All five stay reserved with `build`'s meanings and are deliberately not re-seated.

**`7` versus `11` versus `20`:** a 404 on the epic is a fact about the repository (`7`); an
unreachable GitHub or unreadable file is a fact about nothing (`11`); a *provably absent ledger*
in a proven-real lane is `20` — its repair is `epic open`, named in the message. No message is
worded "does not exist, or is not readable".

---

## `epic open`

**Invocation**

```
fabrika epic open 4300 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic issue this run conducts |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository read |

**Output** — machine. One JSON object:

```
{"answer": "opened", "epic": 4300, "run": "4300-c1a4d6f8", "slices": [
   {"id": "C1", "issue": 4301, "title": "…", "criteria": "found"},
   {"id": "C2", "issue": 4302, "title": "…", "criteria": "found"}],
 "order": ["C1", "C2"], "resumed": false}
```

`"resumed": true` when the nonce-keyed ledger already exists — an idempotent re-open is an
answer, and the run picks up exactly where the ledger left it (the `{aborted, stage}` resume
seam v1's executor proved cheap). The slice list derives from the epic body's planned ledger:
each child ref resolved, its body fetched through the content gate, its acceptance criteria read
through the imported wire format (`found`/`absent`/`malformed` carried as tokens, never
flattened). `order` is the topological order of the imported `## Dependencies` parse — ties
broken by ascending ref, so two runs over one epic derive one order (the determinism the
`epic-ledger` floor proved a stall detector needs).

On first open, creates the ledger directory and writes `run-opened`, and registers the ledger
path in the git exclude mechanism so conductor state can never enter the PR.

Preconditions: tree + claim assertions (`12`/`15`/`11`) on the epic's claim — never `14`; this
verb precedes `build branch` in the loop (the stated exemption in Shared conventions).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the epic body has no parseable planned ledger or `## Dependencies` block — nothing to conduct, fail-closed; "no parseable slices" is never read as "no slices" |
| `7` | the epic is proven absent (404) or closed, or a named child ref is proven absent |
| `10` | the issue is not a `type:epic` — conducting a non-epic is off-vocabulary |
| `11` | the epic, a child, or the ledger path could not be read/created |
| `12`/`15` | the imported tree/claim refusals (`14` is exempted — see Shared conventions) |
| `21` | a ledger exists at this run's key but holds unnameable state |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `epic open: #<n>'s body has no parseable planned ledger — a conductor cannot derive slices from prose; route to the planning lane.` | 4 | refusal |
| `epic open: issue #<n> is proven absent or closed.` | 7 | refusal |
| `epic open: #<n> is not a type:epic — refusing to conduct it.` | 10 | refusal |
| `epic open: cannot read <what>: <reason> — the run state is UNKNOWN.` | 11 | refusal |
| `epic open: the ledger at <run> holds unnameable state (<detail>) — the run needs a human, never a guess.` | 21 | refusal |

**Scope** — one epic, its children, one ledger key. The stderr scope line counts slices derived
and children fetched, so `opened` reads as "N slices, all resolved".

**Examples**

```
$ fabrika epic open 4300
{"answer":"opened","epic":4300,"run":"4300-c1a4d6f8","slices":[{"id":"C1","issue":4301,"title":"extract the parser","criteria":"found"}],"order":["C1"],"resumed":false}
```

```
$ fabrika epic open 4300
epic open: #4300's body has no parseable planned ledger — a conductor cannot derive slices from prose; route to the planning lane.
$ echo $?
4
```

**Grounding**

- #4516 — the run key is `<epic>-<claim-nonce>`, never the session id.
- `type-route.ts` — fail-closed routing: no default arm into the lane with side effects; an
  unparseable plan refuses rather than dispatching.
- #4104's class — slices derive from the topology, never from labels.
- `epic-ledger/validate.ts` — deterministic ordering as a contract, not a nicety.

---

## `epic next`

**Invocation**

```
fabrika epic next 4300
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose run state is relayed |

**Output** — machine. One JSON object, `action` drawn from a closed set:

```
{"action": "dispatch-slice", "slice": "C2", "run": "4300-c1a4d6f8"}
{"action": "evaluate-slice", "slice": "C2", "commit": "8c1f2a9d…"}
{"action": "retry-slice", "slice": "C2", "attempt": 2, "fixFirst": "the parser drops the final row when the input lacks a trailing newline"}
{"action": "escalate-slice", "slice": "C2", "axis": "fail", "attempts": 2}
{"action": "open-pr", "epic": 4300}
{"action": "done", "epic": 4300}
{"action": "halted", "reason": "run-halted recorded"}
```

The fold, in order, entirely from recorded events + git facts: a slice dispatched but not landed
→ verify (`epic landed`) before anything else; a recorded `dispatch-dead` under the dead-axis
cap → `dispatch-slice` again (a fresh dispatch, the dead axis counted — never the fail axis); a
landed slice without a current verdict → `evaluate-slice`; a FAIL verdict under cap →
`retry-slice`, with `fixFirst` carrying the **first line of the recorded FAIL verdict's body** (the one-line Fix-First injection, H3 — derived from
the ledger, not composed here); a breaker at cap → `escalate-slice` with the axis named; every
slice landed + PASS-bound → `open-pr`; a recorded `run-halted` → `halted` (this arm outranks
everything after it); a recorded `pr-opened` → `done`. The answer is a relay of recorded state —
this verb reads no GitHub, spawns nothing, and judges nothing.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `11` | the ledger or the git graph could not be read |
| `12`/`14`/`15` | the imported lane-guard refusals |
| `20` | proven: no ledger at this run's key — run `epic open` first |
| `21` | the ledger holds unnameable state |

`escalate-slice` is an **answer** (exit 0), not the `23` refusal: `next` reports the tripped
breaker as the next action; `23` is what the acting verbs (`record`, `brief`, `verdict`) return
when asked to act past it.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `epic next: no run ledger for #<n> in this lane — run "fabrika epic open <n>" first.` | 20 | refusal |
| `epic next: the ledger at <run> holds unnameable state (<detail>) — refusing to derive a next action.` | 21 | refusal |
| `epic next: cannot read <what>: <reason> — the run state is UNKNOWN.` | 11 | refusal |

**Scope** — one ledger, one local git graph. The stderr scope line names events read and slices
folded.

**Examples**

```
$ fabrika epic next 4300
{"action":"dispatch-slice","slice":"C1","run":"4300-c1a4d6f8"}
```

**Grounding**

- The model-walked state tree does not port (#4891): this verb is the ruled replacement — the
  model asks, the verb answers.
- #4145 / #3929 / #4555 — every reachable state has a name; the unnameable refuses (`21`).
- `post-build.ts` — a dead dispatch short-circuits to verification, never into the grade/repair
  loop.
- H4 / ADR 0130 — the breaker is this verb's arithmetic, bounded even when a failure is
  misclassified.

---

## `epic record`

**Invocation**

```
fabrika epic record 4300 --event slice-dispatched --slice C2 [--detail <text>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose run ledger is appended |
| `--event` | enum (the closed event set, §ledger) | yes | — | the event to append; off-enum is refused |
| `--slice` | string | for slice-scoped events | — | the slice id the event concerns; must exist in the run |
| `--detail` | string | no | — | one line of detail (a classification token, an escalation reason); never free prose read back as instruction |

**Output** — machine. `{"answer": "recorded", "seq": 17, "event": "slice-dispatched", "slice": "C2"}` —
the answer deliberately omits the self-captured `sha`: the tail read-back (below) re-reads the
appended ledger line, which carries it, so the capture is proven from the artifact rather than
echoed in the answer.

**The verb self-captures the current HEAD SHA** into every `slice-dispatched` and `slice-landed`
event it appends (a dedicated `sha` field beside `detail`) — this is what `epic landed` reads as
"the slice's opening SHA" and what `epic verdict`'s landed-commit guard compares against. The SHA
is read from the tree at append time, never taken from the caller: a caller-supplied SHA would
reopen the self-report hole this group exists to close.

Append-only: the verb re-reads the ledger tail after the write and refuses on `9` if the file
does not end with exactly the appended line. `verdict-recorded` is **not** accepted here — it has
its own verb, which is the only writer that can bind a SHA; passing it is a `10` refusal even
though the event is on the ledger's enum. Events that contradict derived state also refuse on
`10` (e.g. `slice-landed` for a slice with no `slice-dispatched`; any slice-scoped event past
that slice's tripped breaker is `23`, excepting only `breaker-tripped` itself and the run-scoped
`run-halted`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `8` | the append was attempted and the file state could not be re-read — the write is UNKNOWN |
| `9` | the tail read-back does not match the appended line |
| `10` | `--event` off-enum, `--slice` unknown to this run, or the event contradicts derived state |
| `11` | the ledger could not be read |
| `12`/`14`/`15` | the imported lane-guard refusals |
| `20` | no ledger at this run's key |
| `21` | the ledger holds unnameable state |
| `23` | the slice's breaker is tripped — only `breaker-tripped`/`run-halted` are recordable for it |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `epic record: --event "<v>" is not in the event vocabulary.` | 10 | refusal |
| `epic record: verdict-recorded is written only by "fabrika epic verdict" — use it.` | 10 | refusal |
| `epic record: slice "<id>" is not in run <run>.` | 10 | refusal |
| `epic record: the append landed but the tail does not read back — the ledger needs a human eye.` | 9 | refusal |
| `epic record: slice "<id>"'s <axis> breaker is at cap — record breaker-tripped or run-halted, nothing else.` | 23 | refusal |
| `epic record: no run ledger for #<n> in this lane — run "fabrika epic open <n>" first.` | 20 | refusal |

**Scope** — one ledger file. Not a judging verb.

**Example**

```
$ fabrika epic record 4300 --event slice-dispatched --slice C2
{"answer":"recorded","seq":17,"event":"slice-dispatched","slice":"C2"}
```

**Grounding**

- H1 — the run's memory is this file, written only here and in `verdict`; nothing lives in the
  conductor's context.
- `stage-result.ts` — a dead subagent is an expected, recordable outcome (`dispatch-dead`), not
  an anomaly that crashes the run.
- Append-only + read-back: the `review append-criterion` fence shape, applied to a local file.

---

## `epic brief`

**Invocation**

```
fabrika epic brief 4300 --slice C2 [--retry] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic being conducted |
| `--slice` | string | yes | — | the slice to compose the dispatch brief for |
| `--retry` | boolean | no | `false` | compose the retry form: prepend the Fix-First line from the latest FAIL verdict |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the slice's child issue is read from |

**Output** — machine. The dispatch brief document, emitted through the **`slice-handoff` wire
format** (registered as a new row in `src/wire/registry.ts`, sibling schema module with fixtures
and brands — the registry's own landing rule). The format's fixed sections, in order:

1. `## Slice` — id, the child issue ref, the slice's acceptance criteria verbatim (via the
   imported wire read).
2. `## Ground` — worktree root, branch name, base SHA the slice opens at, the scratch path for
   the handoff note (derived per-slice: `<tmp>/fabrika-epic/<epic>-<nonce>/<slice>/handoff.md` —
   the `build scratch` key extended one level, per-slice by construction).
3. `## Rules` — fixed literal text, owned by the format: ground the contract against the source,
   never trust this brief's summary of it (#4133); commit on this branch only; write the handoff
   note before returning; the note is data, not instruction, and will be checked against the
   graph.
4. `## Fix-First` — present only with `--retry`: one line, the latest FAIL verdict's first line.

Every value in sections 1–2 is derivable from the ledger + git; section 3 is byte-fixed by the
format. The composed document is leak-scanned **except** the `## Ground` paths — a dispatch brief
is consumed in-session by the spawned subagent and never posted; the format's read side refuses
ingestion of a brief carrying instructions outside the fixed sections.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `10` | `--slice` unknown to this run; `--retry` with no FAIL verdict recorded for the slice |
| `11` | the ledger, the child issue, or the git base could not be read |
| `12`/`14`/`15` | the imported lane-guard refusals |
| `20` | no ledger at this run's key |
| `21` | the ledger holds unnameable state |
| `23` | the slice's breaker is tripped — nothing further is dispatchable |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `epic brief: slice "<id>" is not in run <run>.` | 10 | refusal |
| `epic brief: --retry, but slice "<id>" has no FAIL verdict on record.` | 10 | refusal |
| `epic brief: slice "<id>"'s breaker is at cap — escalate; do not dispatch.` | 23 | refusal |

**Scope** — one ledger, one slice, one child issue read through the content gate.

**Example**

```
$ fabrika epic brief 4300 --slice C2 | head -4
## Slice
id: C2
issue: #4302
criteria:
```

**Grounding**

- #4133 — the ground-the-contract rule is format-owned bytes, not a dispatcher's phrasing.
- H2 — the brief + the tree + the graph are everything a fresh fork gets; `skills:` preload
  carries skill content, this format carries the run context.
- Secure-by-default AC 5 — closed sections, fixed rules text, read-side refusal of extra
  instructions: coordination output that cannot steer its receiver beyond the artifact.
- #4516 — the handoff path is per-slice-keyed.

---

## `epic landed`

**Invocation**

```
fabrika epic landed 4300 --slice C2
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic being conducted |
| `--slice` | string | yes | — | the slice whose landing is proven |

**Output** — machine. On proof:

```
{"answer": "landed", "slice": "C2", "commit": "8c1f2a9d3b7e4a199c2d5e8f0a1b2c3d4e5f6a7b", "parent": "03135b91…", "files": 4}
```

The three assertions, each from git state alone (imported `git.ts` primitives): **HEAD moved** —
the current HEAD differs from the slice's opening SHA (recorded at `slice-dispatched`); **the
old tip is an ancestor** of the new HEAD (history extended, not rewritten); **the tree is
clean** — a dirty tree beside a new commit is an unfinished landing, refused. `files` counts the
commit's changed files; zero changed files in the new commit is `7` (an empty commit proves
nothing landed). The verb answers with the commit SHA — the value `epic verdict` binds.

This verb is what makes a **dead dispatch a proven fact instead of an inferred one**: exit `22`
(HEAD unchanged) after a subagent returned is positive evidence the dispatch produced nothing —
the silent-green class (`eval/spawn.ts`: exit 0, zero turns, nothing anywhere) and the
produced-nothing class both land here, and the skill records `dispatch-dead` on it. A rewritten
history (old tip not an ancestor) is `10` — off the run's vocabulary entirely, needs a human.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the new commit is empty — zero changed files, nothing landed |
| `10` | the old tip is not an ancestor of HEAD — history was rewritten under the run |
| `11` | the ledger or git state could not be read |
| `12`/`14`/`15` | the imported lane-guard refusals |
| `13` | proven: the tree is dirty beside the new HEAD — an unfinished landing (imported `build` seat, trigger widened from `build`'s at-`--require-clean`-open meaning to dirty-at-landing-proof) |
| `20` | no ledger at this run's key |
| `21` | the ledger holds unnameable state |
| `22` | proven: HEAD is unchanged since the slice opened — no commit landed |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `epic landed: HEAD is unchanged since slice "<id>" opened (<sha>) — no commit landed; the dispatch is dead, not the slice failed.` | 22 | refusal |
| `epic landed: <old-tip> is not an ancestor of HEAD — history was rewritten under this run; a human decides.` | 10 | refusal |
| `epic landed: the tree is dirty beside the new commit — an unfinished landing is not a landing.` | 13 | refusal |
| `epic landed: the new commit changes zero files — an empty commit lands nothing.` | 7 | refusal |

**Scope** — this tree's git graph between two SHAs.

**Example**

```
$ fabrika epic landed 4300 --slice C2
{"answer":"landed","slice":"C2","commit":"8c1f2a9d3b7e4a199c2d5e8f0a1b2c3d4e5f6a7b","parent":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","files":4}
```

**Grounding**

- Ruled: artifacts over self-reports (#4891); #4111 / #3993 are the false reports this verb
  replaces. The #4934 ruling's second duty verbatim: read the graph, never the report.
- `eval/spawn.ts` — the silent green; `22` is its conductor-side detector.
- #3837 — the reverting tree: the ancestor + clean assertions catch a tree that moved backward.
- `post-build.ts` — a no-artifact return short-circuits before any evaluator is spawned.

---

## `epic slice-diff`

**Invocation**

```
fabrika epic slice-diff 4300 --commit 8c1f2a9d
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic being conducted |
| `--commit` | string | yes | — | the slice commit to serve, 7–40 hex; resolved in the local graph |

**Output** — machine. The commit's unified diff bytes against its first parent, exactly as
`git show` serves them, preceded by no header of this verb's own. There is no empty answer: an
empty diff is `7`. **Completeness is the local object store's** — this read has no API tier and
no truncation window (#4993's PR-shaped gap is exactly what this verb exists to close for slice
scope); a commit that resolves serves in full or the read fails as `11`.

The evaluator's read path: this verb, then judgment over the bytes — the reviewer reads, never
runs (#4959, restated for slice scope on #4950), and never checks the head out.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the commit's diff is empty |
| `10` | `--commit` is not 7–40 lowercase hex |
| `11` | the git read failed |
| `12` | proven: not in a linked worktree (tree assertions only — an evaluator holds no claim) |
| `24` | proven: the commit is not in this branch's local graph |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `epic slice-diff: <sha> is not in this branch's local graph — nothing to serve.` | 24 | refusal |
| `epic slice-diff: <sha> has an empty diff — nothing to review (ADR 0092).` | 7 | refusal |
| `epic slice-diff: cannot read the local graph: <reason> — UNKNOWN.` | 11 | refusal |

**Scope** — one commit in the local object store.

**Example**

```
$ fabrika epic slice-diff 4300 --commit 8c1f2a9d | head -2
diff --git a/packages/parser/src/rows.ts b/packages/parser/src/rows.ts
index 0b1c2d3..a1b2c3d 100644
```

**Grounding**

- Founder constraint (#4950 comment 5229212703): slice review over the **unpushed** local
  commit — no push, no CI dependency, no draft PR.
- #4993 — the PR diff verb's completeness proof is file-count-based and PR-shaped; the local
  read's completeness is structural, stated rather than assumed.
- #4959 — zero-execution review, inherited at slice scope.

---

## `epic verdict`

**Invocation**

```
fabrika epic verdict 4300 --slice C2 --commit 8c1f2a9d --polarity PASS <<'EOF'
…per-criterion evidence, findings…
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic being conducted |
| `--slice` | string | yes | — | the slice the verdict grades |
| `--commit` | string | yes | — | the exact commit SHA the evaluator read, 7–40 hex |
| `--polarity` | enum: `PASS` \| `FAIL` | yes | — | the verdict; a third token is not a polarity |
| stdin | markdown | yes | — | the verdict body: per-criterion evidence, findings |

**Output** — machine. `{"answer": "recorded", "slice": "C2", "polarity": "PASS", "commit": "8c1f2a9d…", "seq": 19}`.

**What a slice verdict binds to, with no pushed head: the commit SHA in the local graph** — the
run's answer to the open sub-question on #4950. A SHA is content-addressed, so the binding is
structural: any amend or rebase yields a different SHA and the old verdict goes `Unbindable`
against the new graph — a stale slice verdict is unrepresentable rather than detected. **Where
it is recorded, so the conductor can trust it as an artifact:** as a `verdict-recorded` ledger
event whose `detail` is the marker line composed by the imported `verdict-marker.ts` `emit`
(namespace `slice:<id>`, the polarity, the SHA, first line of the body as clause), body stored
beside it. The conductor's trust derives from the write path — only this verb writes the event,
it refuses a SHA that is not the slice's landed commit, and `status`/`next` re-derive the binding
against the live graph on every read (never trusting the recorded line alone).

Guards, in order: stdin non-empty (`3`); `--commit` resolves in the local graph (`24`) **and**
equals the slice's recorded `slice-landed` commit (`10` — a verdict on a commit the run never
landed grades nothing); polarity on-enum (`10`); breaker not tripped (`23`); append + tail
read-back (`8`/`9`). An abbreviated `--commit` is resolved to the full 40-hex SHA in the local
graph before recording — the recorded marker always carries the full SHA.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin held nothing — an empty verdict grades nothing |
| `8` | the append failed — UNKNOWN |
| `9` | the tail read-back does not match |
| `10` | polarity off-enum; or `--commit` is not the slice's landed commit |
| `11` | the ledger or graph could not be read |
| `12`/`14`/`15` | the imported lane-guard refusals |
| `20` | no ledger at this run's key |
| `21` | the ledger holds unnameable state |
| `23` | the slice's breaker is tripped |
| `24` | the commit is not in the local graph |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `epic verdict: no body on stdin — an empty verdict grades nothing.` | 3 | refusal |
| `epic verdict: --commit <sha> is not slice "<id>"'s landed commit (<landed>) — a verdict binds what landed.` | 10 | refusal |
| `epic verdict: --polarity must be PASS or FAIL — got "<v>".` | 10 | refusal |
| `epic verdict: <sha> is not in this branch's local graph.` | 24 | refusal |

**Scope** — one ledger, one commit binding.

**Example**

```
$ fabrika epic verdict 4300 --slice C2 --commit 8c1f2a9d --polarity FAIL <<'EOF'
the parser drops the final row when the input lacks a trailing newline
- criterion 2 unmet: round-trip test absent
EOF
{"answer":"recorded","slice":"C2","polarity":"FAIL","commit":"8c1f2a9d3b7e4a199c2d5e8f0a1b2c3d4e5f6a7b","seq":19}
```

**Grounding**

- H3 — the recorded FAIL's first line is what `next` injects as Fix-First; the format makes that
  derivable, which is why the clause is the body's first line.
- `wire/verdict-marker.ts` — emit imported; the branded SHA floor (7 hex: an ambiguous binding
  is not a binding) rides in.
- `run-evidence.ts` — the four-valued reading discipline: this verb writes; the *read* side
  (`status`) keeps present / none-yet / fail / unbindable distinct, never folding an unmade
  comparison into a negative.
- ADR 0055's boundary, stated: a local ledger has no ACL — authority here is the lane guard
  (claim + tree), which is why only a claim-holding session can record, and why the final
  PR-scope review (which does carry ACL-checked authority) stays exactly as merged.

---

## `epic status`

**Invocation**

```
fabrika epic status 4300
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose run is folded |

**Output** — machine. The whole run folded, derived fresh from ledger + graph:

```
{"run": "4300-c1a4d6f8", "epic": 4300, "branch": "build/4300-epic-slug-c1a4d6f8",
 "slices": [
   {"id": "C1", "state": "passed", "commit": "03135b91…", "verdict": "current"},
   {"id": "C2", "state": "retrying", "commit": "8c1f2a9d…", "verdict": "fail", "failAttempts": 1, "deadAttempts": 0},
   {"id": "C3", "state": "pending", "commit": null, "verdict": "none"}],
 "counters": {"landed": 2, "passed": 1, "escalated": 0}}
```

`state` is the derived per-slice vocabulary, closed: `pending` · `dispatched` · `landed` ·
`passed` · `retrying` · `escalated` · `dead-dispatch`. `verdict` is four-valued against the
**live graph**: `current` (a PASS binds the slice's commit, SHA verified in-graph) · `fail` ·
`none` · `unbindable` (a verdict exists but its SHA is no longer in the graph — surfaced, never
dropped, and never rendered as `current`). This fold is the handoff artifact: a successor session
resumes from `status` + the ledger, not from anyone's narrative.

**Exit status** (beyond the universal four): `11`, `12`/`14`/`15`, `20`, `21` — triggers exactly
as in `epic next`.

**Errors** — `epic next`'s rows with the verb name substituted (shared conventions).

**Scope** — one ledger, one local graph; the stderr scope line counts events folded.

**Example**

```
$ fabrika epic status 4300
{"run":"4300-c1a4d6f8","epic":4300,"branch":"build/4300-epic-slug-c1a4d6f8","slices":[{"id":"C1","state":"passed","commit":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","verdict":"current"}],"counters":{"landed":1,"passed":1,"escalated":0}}
```

**Grounding**

- Scar 6 (`run-evidence.ts`): absent ≠ pending ≠ unknown — the four-valued `verdict` field is
  that discipline over slice verdicts.
- ADR 0058's shape via `bindToHead`: `unbindable` never renders as `current`.
- Terminal reporting (§TERM) reads this fold; a conductor that reports from memory instead of
  `status` re-opens #4111.

---

## Required repo files (verb-level)

The skill's own table ([SKILL.md](SKILL.md)) carries the run-level rows; these are the reads this
contract's verbs make, so an implementer sees the dependency set in one place. Vocabulary:
**fail-loud** / **degrade** / **bootstrap** (front-door, #4952).

| Must exist | Why | When missing |
| --- | --- | --- |
| The epic issue: `type:epic`, planned ledger body, `## Dependencies` block | `epic open` derives the run from it | **fail-loud** — exit `4`/`10` naming the gap; route to the planning lane. |
| Child slice issues with `### Acceptance criteria` blocks | `epic open`/`epic brief` carry each slice's contract via the registered wire format | **fail-loud** — the wire read's `absent`/`malformed` is carried as a token; the skill surfaces it as a plan defect, no criterion is invented. |
| A git repository with a linked epic worktree and the lane branch | every verb's ground; the ledger lives in the worktree | **fail-loud** — the imported lane guard's `12`/`14`/`15`, per the #4934 ruling; never the primary checkout. |
| The `build` group's own repo surfaces | the reused verbs' rows, declared in [`build`'s SKILL.md](../build/SKILL.md) | as declared there — this contract adds no new row to them. |

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag carries
a type and default; every stdout shape has a literal example; every non-zero code is enumerated
with its trigger (per-verb tables own the triggers; the shared matrix owns each code's single
meaning; the universal `0/1/2/127` are stated once); every error names message, stream, and code;
every judging verb states scope and zero-scope behavior; no clause defers to a v1 script, another
skill's prose, or the authoring session — the cross-references are to **landed sibling fabrika
contracts and shipped modules by path**, the sanctioned shape. The three hand-checks: every
reachable outcome was walked per verb (including the dead-dispatch, rewritten-history, and
unnameable-ledger modes v1 had no names for); every example value is derivable (the run key from
epic + claim nonce, the commit from `landed`'s output, `fixFirst` from the FAIL body's first
line); sibling verbs guard shared preconditions identically (every state-touching verb runs the
imported lane guard; `slice-diff` runs the tree assertions only, stated with its reason).
