# `/build` — derived CLI contract

**Skill:** [`build`](SKILL.md) · **Authoring brief:** [#4707](https://github.com/kamp-us/phoenix/issues/4707) · **Date:** 2026-08-08

The verbs land in `packages/fabrika-cli/` under the `build` subcommand group, registered in
`packages/fabrika-cli/src/registry.ts` like the shipped `adr`, `report`, `triage` and `wire`
groups. The [CLI interface convention](../../docs/cli-interface-convention.md) governs every verb;
where this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). Every v1 tool
named below is prior art that was **read** for its semantics and scars — `claim`, `verified-push`,
`scratchpad`, `worktree-guard`, `checks` — and none is invoked, wrapped, or deferred to. Where a
scar is named, the verb here designs it out; that is the only thing a rebuild inherits.

**What fabrika already ships, reused by import — never respecified:**

- `packages/fabrika-cli/src/wire/acceptance-criteria.ts` — the total `read` over an issue body's
  `### Acceptance criteria` block (`Found` / `Absent` / `Malformed`). `build issue` imports it.
- `packages/fabrika-cli/src/wire/verdict-marker.ts` — the verdict-marker `read` and its
  head-binding (`bindToHead`). `build verdicts` imports both.
- `packages/fabrika-cli/src/report/leaks.ts` — `scanBody` and `isBareAtReference`, the
  machine-local-path predicates. `build pr` and `build note` import them.
- `packages/fabrika-cli/src/report/compose.ts` — `normalizeForReadback` (three steps: CRLF→LF,
  strip trailing spaces/tabs per line, strip trailing newlines — read the body, the docblock
  understates it). Both writing verbs' read-backs compare through it, never byte-for-byte:
  GitHub's round-tripping is not byte-stable and asserting it fires a false mismatch on clean runs.

A restatement of any of these would be a transcription, and a transcription drifts. The spec says
*import this*, with the path.

**Considered and deliberately not derived** — each is a question already enforced at a gate, and a
second answer to a gated question can contradict the gate (interface convention rule 6):

- **A control-plane classifier.** CODEOWNERS decides §CP membership at the merge gate. `build pr`
  *refuses a body that asserts the classification* (#4153) — it never computes one.
- **A changed-files leak scanner.** `leak-guard.yml` reds it in CI. The writing verbs guard only
  the text this skill itself posts.
- **A CI-rollup reader.** `ci.yml` owns redness; the review/ship stages read it. `build check` is
  an in-tree *prediction*, not a second verdict over the gate's question.
- **A trivial-diff classifier.** v1's ships dormant by design (ADR 0120); nothing here consumes it.
- **A worktree provisioner, locker, or reaper.** The 2026-08-03 amendment on #4707 measured the v1
  worktree machinery as accretion (8 ADRs, 3,600 LOC, three reapers) and ruled the direction:
  **the spawner owns the tree's lifecycle**. `build tree` verifies; it never creates, locks,
  unlocks, or removes.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `build tree` | prove the ground: a linked worktree, optionally clean, optionally this lane's | three git-derivable assertions — no judgment; *what to do on a refusal* (stop, report) stays in the skill |
| `build pick` | the ranked candidate pool: `status:triaged` + `ready-for:agent` + unassigned, paginated | a label/assignee filter over a paged listing — no judgment; the *choice* among candidates stays in the skill |
| `build eligible` | one issue's dependency gate: `eligible` / blocked-by-named-edge / UNKNOWN | derivable entirely from the parent ledger's `## Dependencies` and issue states |
| `build claim` | race the earliest-authorized claim on an issue; win, or name the winner | a deterministic race protocol; *what to do on a loss* stays in the skill |
| `build confirm` | re-prove this session still holds the claim before a mutation | a lookup with a defined answer |
| `build release` | retract this session's own claim | a guarded single write |
| `build issue` | the claimed issue's body + parsed acceptance criteria, through the content gate | fetch + parse via the wire module; *judging* the criteria stays in the skill |
| `build branch` | cut (or resume) the lane's nonce branch off a freshly fetched base | fetch, derive, create — the nonce is a function of the claim token |
| `build scratch` | the per-lane scratch path, allocated fail-closed | deterministic path derivation keyed session + issue + claim nonce |
| `build check` | run this surface's validators in this tree, cache-bypassed; green/red/unknown | command execution + tree-binding assertions; *fixing red* stays in the skill |
| `build push` | publish the branch and independently confirm the remote ref moved | push + `ls-remote` read-back, three proven outcomes |
| `build pr` | open the PR from a stdin body, refusing the known defect shapes, with read-back | mechanical guards over an authored body; *authoring* stays in the skill |
| `build note` | post a progress/handoff comment, head-stamped, leak-guarded, with read-back | as `report note`, plus the head stamp |
| `build verdicts` | the paginated, current-head, per-gate verdict fold on a PR | fetch-all + fold via the wire module; *acting on rows* stays in the skill |

**Considered and not derived: a surface classifier.** Naming the surface (code / prose / plan) is
a judgment the skill makes reading the issue; a verb that guessed it from file extensions would be
wrong exactly on the mixed PRs where the answer matters. `build check` takes the skill's answer as
`--surface` and validates it against the diff (a `--surface prose` run over changed `.ts` files
refuses) — an anchor, not a second classifier.

## Shared conventions

Every verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries the answer and nothing else — JSON objects with
  named keys, or a line grammar, per verb. Scope lines, refusal reasons and progress go to stderr.
  A non-zero exit prints **nothing** on stdout (the `refuse` shape in `packages/fabrika-cli/src/verb.ts`): a partial answer
  beside a failure invites reading the bytes without the status.
- **Common inputs.** `--repo <owner/name>` (default: resolved from the `origin` remote). `--json`
  is the default and only output mode where a shape is JSON; line-grammar verbs say so. GitHub
  access per [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)
  — the paginate half is what this group most depends on: a truncated page is the un-paginated scar
  it exists to close (#4926; v1's `per_page=100` comment reads in `stepR1-verdicts.sh`).
- **The content gate.** Every externally-authorable byte a verb returns — issue bodies, comments,
  PR bodies, review text — passes through one shared module,
  `packages/fabrika-cli/src/build/content-gate.ts`, before it reaches stdout. Today the gate is
  provenance-stamping pass-through, because the trust posture is an **open founder decision**
  (#4859). It exists so that ruling lands as **one module change**, fail-closed, covering
  forward/back-referenced content — not as an edit to five verbs. TOCTOU is handled by
  construction: no verb caches content across invocations; every invocation re-fetches and
  re-gates, so a gate change is in force on the next read.
- **Isolation preconditions are guarded identically wherever they apply.** `branch`, `check`,
  `push` and `pr` run the same tree assertions `tree` runs, with the same codes (`note` runs only
  the posting guards — a stop-report must remain postable from a refused tree) — a sibling that
  took the same ground unguarded would be the split this table exists to prevent.
  Their refusal messages are `tree`'s rows with the verb-name prefix substituted; **every error
  message contract-wide is prefixed with the invoked verb's name**, stated once here.
- **A non-zero exit is UNKNOWN** to the caller until the code is read. No verb prints a partial or
  permissive answer on a non-zero exit.
- **One deviant on the channel rule, carved out here so the shared section stays true:**
  `build push` puts its entire report on stdout, single-stream, so that the last stdout line is
  always the verdict line — the ordering guarantee is the contract (see its block; v1 documented
  this idiom and then shipped it on the wrong stream).

### The shared exit matrix

The one table every `build` verb allocates from — this matrix owns `code → meaning`; each verb's
block below enumerates only **that verb's own reachable proven outcomes** with their triggers, and
its `--help` restates them. `0`, `1`, `2` and `127` are the interface convention's reserved codes
(`packages/fabrika-cli/src/verb.ts`, the exit-2 bootstrap in `packages/fabrika-cli/src/bin.ts`): every verb can also return those four, and
they are stated only here.

**Alignment with the shipped `report`/`triage` tables is deliberate and code-for-code over
`3`–`11`** (`packages/fabrika-cli/src/report/codes.ts`, `packages/fabrika-cli/src/triage/codes.ts`):
a caller driving `report`, `triage` and `build` in one sweep reads one meaning per code.
**`12`+ diverges from `triage` by design** — `triage`'s `12`/`13` are `HUMAN_FILED`/`UNCONFIRMED`,
outcomes no `build` verb can produce; the alignment doctrine spans the overlap, not the whole
range, exactly as `triage/codes.ts` itself states for `adr`.

| Code | Meaning |
|---|---|
| `0` | the answer is on stdout |
| `1` | usage error, or the verb failed to run |
| `2` | no implementation could be resolved (`packages/fabrika-cli/src/bin.ts`) |
| `3` | stdin was read and held nothing |
| `4` | a required section is missing, malformed, empty, or out of place — in an authored body, or in a document a verb derives from |
| `5` | the authored text carries a machine-local path, unredacted |
| `6` | the authored text is a bare `@` path reference — not redactable |
| `7` | zero scope: the target is **proven** absent (404) or closed, the vocabulary judged against is empty, or there is nothing to judge |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1` (it may or may not have landed) |
| `9` | the write landed but the read-back does not match; the artifact exists and needs a human |
| `10` | a value off its closed vocabulary, or a classification claim where none is permitted (a non-kebab slug, an off-enum surface, a §CP claim in a body) — a semantic refusal, never a malformed-flag usage error, which is `1` |
| `11` | a required read or validator execution failed — nothing was written, no outcome is proven |
| `12` | proven: this process is not in a linked worktree (the primary checkout, or no worktree at all) |
| `13` | proven: the tree was dirty at a `--require-clean` open |
| `14` | proven: the checked-out branch does not belong to this lane's claim |
| `15` | proven: this session does not hold the claim — lost, foreign, or none exists at all; the detail is on stderr |
| `16` | proven: the issue is blocked — the open dependency edge is named on stderr |
| `17` | proven: the push completed but the remote ref did not move |
| `18` | proven: this tree's validation is red |
| `19` | refused: the requested push is unsafe (detached HEAD, or a non-fast-forward without `--force-with-lease`) |
| `127` | the verb never ran at all (unresolved binary — the shell's code, not this process's) |

**`7` versus `11` is the split the whole group rests on** (the `wire` group's `ABSENT` vs
`ARTIFACT_UNKNOWN` distinction, `packages/fabrika-cli/src/wire/codes.ts`): a 404 is a verdict about the repository; a
5xx or timeout is a verdict about nothing. No verb fuses them, and no error message is worded
"does not exist, or is not readable".

---

## `build tree`

**Invocation**

```
fabrika build tree [--require-clean] [--issue <n>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--require-clean` | boolean | no | `false` | additionally refuse a tree with any uncommitted change — the lane-open posture |
| `--issue` | integer | no | — | additionally prove the checked-out branch carries this claim's nonce — the pre-mutation posture |

**Output** — machine. One line, the tree root's absolute path, newline-terminated. This verb
**verifies and never provisions**: it creates nothing, locks nothing, removes nothing — the
spawner owns the tree's lifecycle (the 2026-08-03 amendment on #4707), and a verifier that could
also repair would be the self-provision path the incident record closes.

The three assertions, each proven from git state alone:

1. **A linked worktree** — the git dir and the common dir differ. The primary checkout, or no
   repository at all, is `12`.
2. **Clean at open** (`--require-clean`) — any uncommitted change is `13`. A fresh tree carrying
   an unauthored hunk is not yours to keep *or* to clean (#2666).
3. **This lane's branch** (`--issue`) — the checked-out branch parses as a lane branch whose
   number is `--issue` and whose nonce matches this session's confirmed claim (the lane-identity
   rule, defined in `build branch`); a foreign, wrong-number, or nonce-less branch is `14`. No
   stamp file exists to check: ownership is derivable, not recorded.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `11` | with `--issue`: the claim state could not be read — the lane is UNKNOWN |
| `12` | proven: not in a linked worktree (the primary checkout, or outside any repository) |
| `13` | proven: uncommitted changes present at a `--require-clean` open |
| `14` | proven: the checked-out branch does not carry this claim's nonce |
| `15` | proven: the claim on `--issue` is foreign |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build tree: this is the primary checkout, not a linked worktree — stop; never build here.` | 12 | refusal |
| `build tree: <n> uncommitted change(s) at open — refusing; an unauthored hunk is not yours to keep or clean.` | 13 | refusal |
| `build tree: the checked-out branch "<name>" does not carry claim <token>'s nonce — wrong lane.` | 14 | refusal |
| `build tree: cannot read the claim markers on #<n>: <reason> — the lane is UNKNOWN.` | 11 | refusal |
| `build tree: #<n> is held by <token>, not this session.` | 15 | refusal |

**Scope** — not a judging verb: it reads this process's git state and, with `--issue`, one claim.

**Examples**

```
$ fabrika build tree --require-clean
/private/var/folders/…/lanes/build-4312
```

```
$ fabrika build tree
build tree: this is the primary checkout, not a linked worktree — stop; never build here.
$ echo $?
12
```

**Grounding**

- #3744 / #3594 / #4162 — work landing silently in the shared primary checkout; the refusal is
  loud and terminal, and the skill re-runs this verb before every git mutation because the cwd
  resets between shell calls.
- #2666 — the dirty fresh tree; refused, never cleaned.
- #4500 — eight trees under one stamp; the nonce comparison has no stamp to duplicate.
- 2026-08-03 amendment on #4707 — spawner-owned lifecycle; this verb is the trap, not the
  machinery.

---

## `build pick`

**Invocation**

```
fabrika build pick [--repo <owner/name>] [--limit <n>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository whose issue board is read |
| `--limit` | integer | no | `20` | maximum candidates to emit, after ranking |

**Output** — machine. One JSON object: `{"pool": [...], "scanned": {"p0": n, "p1": n, "p2": n}}`.
Each pool entry: `{"number", "title", "priority", "type", "home"}` — `home` is the open
milestone's number as a string, or the standing-lane label (`wayfinder:backlog` /
`axis:pipeline-hardening`) for a lane-exempt issue. Ranked `p0` → `p1` → `p2`, milestone order
within a bucket. **An empty pool is a fact and prints `{"pool": [], ...}` on exit
0** with the scanned counts proving what was searched — never an empty stdout (interface
convention rule 2).

The filter, fail-closed on every axis:

- `status:triaged` present, `status:` nothing-else;
- **`ready-for:agent` present.** An issue with no `ready-for:` label is *excluded* — absence is an
  unknown audience, never an agent audience (#4780). This is the negative test the brief's
  acceptance criterion names.
- **unassigned.** Any assignee excludes — assignment is the one attribute that keeps a human's
  document out of this pool (#4764, #4693).
- `type:` is one of `feature` / `chore` / `bug` / `investigation`. `type:decision` and `type:epic`
  never enter; a rendered-visual deliverable is excluded by the *skill* at reading time, not by
  this verb, because modality is not a label.
- open, and not a pull request.

**Every bucket read paginates, and a failed bucket read fails the verb.** v1's candidate pool
printed nothing for a failed bucket and kept going — a gh 5xx on the p0 bucket silently read as
"no p0s" (`step1-candidate-pool.sh:12-13`, its own header admits it; #4926 is the pagination
half). Here either every bucket was read in full or the answer is `11`.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `11` | any bucket read failed or came back truncated — the pool is UNKNOWN, never partial |

A malformed `--limit` is a plain usage error: `1`, per the reserved table.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build pick: cannot read the <bucket> bucket: <reason> — the pool is UNKNOWN, never partial.` | 11 | refusal |
| `build pick: --limit "<value>" is not a positive integer.` | 1 | usage error |

**Scope** — every open issue in `--repo` carrying `status:triaged`, read via paginated REST. The
scope line on stderr names the per-bucket counts scanned, so an empty pool is auditable.

**Examples**

```
$ fabrika build pick
{"pool":[{"number":4312,"title":"Editor loses focus after save","priority":"p1","type":"bug","home":"47"}],"scanned":{"p0":0,"p1":3,"p2":41}}
```

```
$ fabrika build pick --limit 0
build pick: --limit "0" is not a positive integer.
$ echo $?
1
```

**Grounding**

- #4780 — `ready-for:agent` fail-closed; absence is an unknown audience. Negative test required.
- #4764 / #4693 — assigned means not pickable; 17 authoring briefs were protected only by an
  advisory before this rule.
- #4926 — v1's pool truncated at 100 per bucket, unpaginated.
- `step1-candidate-pool.sh` scar — a failed bucket read fail-opened to an empty bucket; here `11`.
- ADR 0092 — the scanned counts on stderr are the zero-scope audit trail.

---

## `build eligible`

**Invocation**

```
fabrika build eligible 4312 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue whose dependency gate is derived |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository read |

**Output** — machine. On `eligible`: one JSON object
`{"answer": "eligible", "number": 4312, "parent": 4300}` (`parent` is `null` for a standalone
issue). Blocked and unknown produce no stdout — they are exits `16` and `11`.

The derivation: resolve the parent epic (three-way — parent found / proven standalone /
unreadable). For a child, read the parent ledger's `## Dependencies` topology and the states of
every predecessor: a phase predecessor still open, or an open `requires:` edge, is a block, and
the *first* blocking edge is named on stderr (#4244). Blockedness is **derived from the topology,
never read off a label** — a label is a claim, the topology is the fact. The parent body arrives
through the content gate.

**The `## Dependencies` grammar — canonical here** (no wire module ships for it yet; when one
lands in `packages/fabrika-cli/src/wire/`, it implements this section and this section becomes a
pointer). The section holds only blank lines and list lines of two forms:

```
- phase <int>: <ref>[, <ref>…]
- <ref> requires: <ref>[, <ref>…]
```

where `<ref>` is `#<int>` (an issue) or a ledger-local id matching `C<int>`. Semantics: an issue
in phase *k* is blocked while any ref in a phase < *k* is open; a `requires:` line blocks its
subject while any listed ref is open; a ledger-local ref resolves within the ledger, an issue ref
resolves to that issue's state. Any other non-blank line inside the section is **unparseable**,
and the whole derivation refuses on `4` — "no parseable edges" is never read as "no edges".
`build check --surface plan` validates this same grammar, and
[`references/plan.md`](references/plan.md) points authors at it.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the parent ledger was read but its `## Dependencies` block is absent or unparseable — eligibility cannot be derived, fail-closed |
| `7` | the issue is proven absent (404) or closed |
| `11` | the issue, parent, or any predecessor could not be read — eligibility is UNKNOWN |
| `16` | proven blocked — an open predecessor or `requires:` edge, named on stderr |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build eligible: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build eligible: parent #<p> has no parseable "## Dependencies" block — eligibility cannot be derived, and "no edges found" is never read as "eligible".` | 4 | refusal |
| `build eligible: cannot read <what>: <reason> — eligibility is UNKNOWN, never "eligible".` | 11 | refusal |
| `build eligible: blocked by open <edge-kind> #<m>.` | 16 | refusal |

**Scope** — one issue, its parent (if any), and every predecessor the parent's topology names.
The scope line on stderr counts the edges checked, so `eligible` is readable as "N edges, all
closed", never as "no edges found".

**Examples**

```
$ fabrika build eligible 4312
{"answer":"eligible","number":4312,"parent":null}
```

```
$ fabrika build eligible 4319
build eligible: blocked by open requires: edge #4310.
$ echo $?
16
```

**Grounding**

- #4244 — lane entry must refuse while a `requires:` member is open.
- #4920 — the eligibility question needed a verb; prose-derived blockedness was re-derived
  differently per session.
- #4104 — `status:planned` children invisible to a label-driven picker; topology-derived here.
- ADR 0092 — an unreadable predecessor is `11`, never a pass.

---

## `build claim`, `build confirm`, `build release`

One protocol, three verbs. The claim is a comment-marker race on the issue (the ADR 0115 shape,
re-implemented): post a claim marker carrying the session's token, re-read the issue's markers,
and the earliest authorized marker wins. **Authorization is ACL-checked** — the marker's *author*
is resolved against repository permissions (the ADR 0055 idiom); the marker's *text* confers
nothing. The token is `build:<session-id>:<uuid>` — one shape, pinned, because v1 left the token
shape ambiguous between comment ids and session ids and callers guessed (#4428).

**Invocation**

```
fabrika build claim 4312 [--repo <owner/name>]
fabrika build confirm 4312 [--repo <owner/name>]
fabrika build release 4312 [--repo <owner/name>]
```

**Inputs** — identical for all three verbs:

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue (or, in repair, the PR) the claim concerns |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository whose markers are read and written |

The session id arrives from the environment (`CLAUDE_CODE_SESSION_ID`, named in `--help` with its
unset behavior: unset is a usage error, exit `1` — a claim without an identity is not a claim).

**Output** — machine, one JSON object:

- `claim` on a win: `{"answer": "won", "number": 4312, "token": "build:<sid>:<uuid>"}`.
- `confirm` when held: `{"answer": "mine", "number": 4312, "token": "..."}`.
- `release` when released: `{"answer": "released", "number": 4312}`.

A loss, a foreign confirm, and a not-mine release produce no stdout — they are exit `15`, the
winner named on stderr. **A lost race is a proven outcome on its own code, never exit 0** — v1's
direct-claim script exited 0 on both won and lost and left routing to prose
(`step3-direct-claim.sh:31,40`, its header admits it), and v1's `claim is-mine` fused "proven
lost" with "no session id" on exit 1 (`claim/command.ts:57`). Both are designed out: `15` is
proven-foreign only; a missing session id is `1`; an unreadable marker set is `11`.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the issue is proven absent (404) or closed |
| `8` | the marker write failed — it may or may not have landed; re-run `confirm` before anything else |
| `9` | the marker landed but the read-back does not match |
| `11` | the marker set could not be read — ownership is UNKNOWN, never "unclaimed" |
| `15` | proven: another session's earlier authorized marker wins (`claim`), holds (`confirm`), or `release` was asked for a token this session does not hold |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build claim: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build claim: the marker write failed: <reason> — the claim state is UNKNOWN; run "fabrika build confirm <n>" before any further action.` | 8 | refusal |
| `build claim: cannot read the claim markers on #<n>: <reason> — ownership is UNKNOWN, never "unclaimed".` | 11 | refusal |
| `build claim: lost to <token> (posted <timestamp>, authorized).` | 15 | refusal |
| `build claim: the marker landed but the read-back does not match — the claim needs a human eye.` | 9 | refusal |
| `build confirm: #<n> is held by <token>, not this session.` | 15 | refusal |
| `build confirm: no claim exists on #<n> — nothing to confirm; run "fabrika build claim <n>" first.` | 15 | refusal |
| `build release: this session holds no claim on #<n> — refusing to release another lane's.` | 15 | refusal |

**Proven-unclaimed sits on `15` too**: zero markers means this session does not hold the claim,
which is the one fact every `15` consumer acts on (stop mutating; claim first). The stderr detail
separates unclaimed from foreign for a reader; the code deliberately does not, because the caller
action is identical. The same reading applies wherever a sibling verb's precondition says
"claim confirmed (`15`/`11`)": an unclaimed target refuses on `15` with the no-claim message.

**Scope** — one issue's comment markers, paginated in full. An unauthorized author's marker is
counted and reported on stderr but never wins — content is not authority.

**Examples**

```
$ fabrika build claim 4312
{"answer":"won","number":4312,"token":"build:s-9f2e:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d"}
```

```
$ fabrika build confirm 4312
build confirm: #4312 is held by build:s-77aa:9d8c7b6a-5f4e-3d2c-1b0a-998877665544, not this session.
$ echo $?
15
```

**Grounding**

- ADR 0115 — detect-and-tiebreak comment claims; re-implemented, never called (ADR 0238).
- ADR 0055 — authorization from repository permissions, never from marker text.
- #4428 — the token shape is pinned here because callers guessed between two shapes.
- #2997 — `confirm` before every number-addressed mutation is the guard that pins the actor.
- #4145 is an **open decision** on who releases a *delegated* claim (run vs lane). This contract
  encodes the conservative floor — `release` releases only this session's own token at its
  terminus — and does not pre-rule the delegation question; when #4145 rules, the change lands
  here.
- v1 scars designed out: `step3-direct-claim.sh` exit-0-on-lost; `claim/command.ts:57` fused
  refusals; `claim/github.ts:229-231` where a transient permission-read failure silently demoted
  an authorized author (here that read failing is `11`, never a silent demotion).

---

## `build issue`

**Invocation**

```
fabrika build issue 4312 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue to read |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository read |

**Output** — machine. One JSON object:

```
{"number": 4312, "title": "...", "state": "open", "labels": ["type:bug", "p1", "status:triaged", "ready-for:agent"],
 "body": "...", "criteria": {"state": "found", "items": [{"text": "...", "checked": false}]}}
```

`criteria` comes from the imported `acceptance-criteria` wire read and carries its three answers
as positive tokens: `found` (with `items`), `absent` (no block reaches for the heading — a fact
the skill judges), `malformed` (something reaches for it and misses — a *defect* the skill must
surface, never silently treat as absent). The distinction is the wire module's whole design;
this verb transports it, it does not flatten it. The body passes through the content gate.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the issue is proven absent (404) or closed |
| `11` | the issue could not be read — its content is UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build issue: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build issue: cannot read #<n>: <reason> — its content is UNKNOWN.` | 11 | refusal |

**Scope** — one issue. Not a judging verb; the empty-vs-failed distinction lives in `criteria.state`
versus exit `11`.

**Example**

```
$ fabrika build issue 4312
{"number":4312,"title":"Editor loses focus after save","state":"open","labels":["type:bug","p1","status:triaged","ready-for:agent"],"body":"…","criteria":{"state":"found","items":[{"text":"focus stays in the editor after save","checked":false}]}}
```

**Grounding**

- Secure-by-default AC 3 — every external-content read routes through a verb; this is the issue
  read's single door, and the #4859 posture lands in its content gate.
- The wire module's `Absent` vs `Malformed` split — a drifted heading must never read as "no
  acceptance criteria" (#4735's class: a gate grading a PR over nothing).

---

## `build branch`

**Invocation**

```
fabrika build branch 4312 --slug editor-focus-loss [--base <ref>]
fabrika build branch --resume 4310
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes (create mode) | — | the claimed issue the branch serves |
| `--slug` | string | yes (create mode) | — | kebab-case, ≤5 words, must not begin with `-` |
| `--base` | string | no | `origin/main` | the base ref, **fetched before the branch is cut** |
| `--resume` | integer | exclusive with the positional | — | a PR number whose head branch to switch to, for repair |

**Output** — machine. One line, the checked-out lane branch's name, newline-terminated.

**Lane identity, defined once here and consumed by every code-`14` check.** A lane branch's name
carries the lane: `build/<number>-<slug>-<nonce>` in create mode, `build/pr-<pr>-<nonce>` in
resume mode, where `<nonce>` is the first 8 hex of the **current** claim token's UUID. A verb
proving "this lane's branch" (`tree --issue`, `check`, `push`, `pr`) parses `<number>` (or
`<pr>`) and `<nonce>` out of the checked-out branch's name, re-reads that number's claim through
the ACL check, and requires this session to hold it with a token whose UUID prefix equals the
nonce. Wrong number, wrong nonce, or an unparseable branch name is `14`; a claim readable and
held by another session is `15`; an unreadable claim is `11` — every code-`14` consumer can
therefore also return `14`, `15` and `11`, and enumerates all three. No verb needs a flag to
find the lane — the branch name is the record, and there is no
stamp file to duplicate or go stale (the stamp machinery is the accretion the 2026-08-03
amendment measured, and it is not rebuilt).

Create mode: fetch `--base`, cut `build/<number>-<slug>-<nonce>` off `FETCH_HEAD` (never a stale
local ref), switch to it. Resume mode: resolve the PR's current head branch, fetch it, and check
it out under the **local** lane name `build/pr-<pr>-<nonce>` with its upstream set to the remote
head branch — `build push` publishes via that tracked upstream, so the PR updates while the local
name carries the *current* repair claim's nonce. Each repair run gets its own local branch, so a
dead earlier lane can never pin this one (#4868's class). A closed or merged PR refuses (`7`).

Preconditions, guarded identically to `build tree`: a linked worktree (`12`), a confirmed claim
(`15` / `11`) — in create mode on `<number>`, in resume mode on the `--resume` PR's number, which
is the number repair mode claims.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | `--resume`'s PR is proven absent, closed, or merged |
| `10` | `--slug` is not kebab-case, exceeds 5 words, or is flag-shaped |
| `11` | the fetch failed, or the claim state could not be read |
| `12` | proven: not in a linked worktree |
| `15` | proven: the claim on `<number>` is foreign |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build branch: --slug "<value>" is not kebab-case (lowercase letters, digits, single hyphens, ≤5 words).` | 10 | refusal |
| `build branch: cannot fetch <ref>: <reason> — refusing to cut a branch off a stale base.` | 11 | refusal |
| `build branch: PR #<n> is proven closed or merged — nothing to resume.` | 7 | refusal |
| `build branch: this is the primary checkout — refusing to branch here.` | 12 | refusal |
| `build branch: #<n> is held by <token>, not this session.` | 15 | refusal |

**Scope** — not a judging verb. It mutates only the current tree's HEAD and local refs.

**Examples**

```
$ fabrika build branch 4312 --slug editor-focus-loss
build/4312-editor-focus-loss-c1a4d6f8
```

```
$ fabrika build branch 4312 --slug -rf
build branch: --slug "-rf" is not kebab-case (lowercase letters, digits, single hyphens, ≤5 words).
$ echo $?
10
```

**Grounding**

- #1920 / #3621 — branch off `FETCH_HEAD` after a real fetch; a stale local `origin/main` is the
  recurring wrong base.
- #4854 — the flag-shaped-slug refusal.
- #4500 — eight trees, one stamp: identity via per-claim nonce makes duplicate lanes
  unconstructible instead of detected.
- 2026-08-03 amendment on #4707 — no stamp files; ownership is derivable from git.

---

## `build scratch`

**Invocation**

```
fabrika build scratch 4312 --slug notes
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the claimed issue this lane serves |
| `--slug` | string | yes | — | the file's leaf name, kebab-case, no path separators |

**Output** — machine. Exactly one absolute path on stdout, newline-terminated:
`<OS temp root>/fabrika-build/<session-id>/<issue>-<claim-nonce>/<slug>` — the fixed
`fabrika-build` segment namespaces the allocator against everything else in the temp root. The
directory is created if absent. **The claim nonce in the key is what v1's allocator lacked**: v1 keyed on the session id
alone, so two lanes (or two roles) of one session shared a namespace and clobbered each other's
fixed-name files (#4516, #4544, #4875, #4692); v1's own stamp could not separate two pid-less
runs (`scratchpad.ts:26-29`, documented in-source). Keying on the confirmed claim makes the
namespace per-lane by construction.

Preconditions: a confirmed claim on `<number>` (`15` / `11`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `10` | `--slug` carries a path separator, or is not kebab-case |
| `11` | the claim state could not be read |
| `15` | proven: the claim on `<number>` is foreign |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build scratch: --slug "<value>" must be a kebab-case leaf, no path separators.` | 10 | refusal |
| `build scratch: cannot create <dir>: <reason>` | 1 | refusal (the universal `1` — the verb failed to run) |
| `build scratch: cannot read the claim markers on #<n>: <reason> — the lane is UNKNOWN.` | 11 | refusal |
| `build scratch: #<n> is held by <token>, not this session.` | 15 | refusal |

**Scope** — not a judging verb. Creates one directory, prints one path, writes no file content.

**Example**

```
$ fabrika build scratch 4312 --slug notes
/tmp/fabrika-build/s-9f2e/4312-c1a4d6f8/notes
```

**Grounding**

- #4516 / #4875 / #4692 / #4544 — the shared-namespace clobber class; per-lane keying is the fix
  the four-skill patch deliberately did not extend to write-code.
- #3086 / #3718 — a fixed `/tmp` leaf is banned; the path is derived, never invented.
- The printed path is machine-local by definition: it must never appear in any posted artifact —
  `build pr` and `build note` red on it (`5`).

---

## `build check`

**Invocation**

```
fabrika build check --surface code
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--surface` | enum: `code` \| `prose` \| `plan` | yes | — | the surface whose validators run; the skill names it, this verb anchors it |

**Output** — machine. On green, one JSON object:
`{"verdict": "green", "surface": "code", "tree": "<abs tree root>", "ran": ["pnpm typecheck", "pnpm lint:worktree"]}`.
Red and unknown produce no stdout (`18` / `11`), diagnostics on stderr verbatim from the runners.

Per surface:

- **code** — the exact CI commands (`pnpm typecheck`, `pnpm lint:worktree`), executed in this
  tree **with the build cache bypassed** (turbo `--force`). A cache hit from another worktree
  returned another tree's green three times in one session (#4106) and recurred on the review
  side (#4887); bypassing is cheaper than trusting a key that has already lied.
- **prose** — changed markdown files: every relative link resolves against this tree; no
  machine-local path (the imported `leaks.ts` predicate); every fabrika-doc reference cited by id
  exists.
- **plan** — the changed ledger's `## Dependencies` block parses under the canonical grammar
  (defined in `build eligible`): issue refs (`#<int>`) resolve to real issues, ledger-local refs
  (`C<int>`) resolve within the ledger, and no child is its own predecessor.

The surface anchor: the verb diffs the branch against its base and refuses a surface that does not
match the diff (`--surface prose` over changed `.ts` files is `10`) — the skill's judgment is
taken, then checked against the tree, never silently accepted.

Preconditions: a linked worktree (`12`), the lane's branch checked out (`14`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the diff against the branch base is empty — nothing to validate, zero scope |
| `10` | `--surface` is off-enum, or provably mismatches the diff |
| `11` | a validator could not be executed, or the lane's claim could not be read — the verdict is UNKNOWN, never green |
| `12` | proven: not in a linked worktree |
| `14` | proven: the checked-out branch is not this lane's (lane-identity rule) |
| `15` | proven: the lane's claim is held by another session |
| `18` | proven red — the failing runner and its diagnostics are on stderr |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build check: <runner> could not be executed: <reason> — the verdict is UNKNOWN, never green.` | 11 | refusal |
| `build check: cannot read the claim markers on #<n>: <reason> — the lane is UNKNOWN.` | 11 | refusal |
| `build check: #<n> is held by <token>, not this session.` | 15 | refusal |
| `build check: --surface prose, but the diff is 14 .ts files — the surface is provably wrong.` | 10 | refusal |
| `build check: the diff against <base> is empty — nothing to validate (ADR 0092).` | 7 | refusal |
| `build check: red — <runner> failed; diagnostics above.` | 18 | refusal |

**Scope** — this tree's diff against the branch base. A zero-file diff is `7` — zero scope, never
a green (ADR 0092).

**Example**

```
$ fabrika build check --surface code
{"verdict":"green","surface":"code","tree":"/private/var/folders/…/build-4312","ran":["pnpm typecheck","pnpm lint:worktree"]}
```

**Grounding**

- #4106 / #4887 — the cross-tree cache false green; cache bypass is the design, not an option.
- v1's discipline was prose-only (`SKILL.md:895-935`, exact-CI-command mandate with no
  enforcement); here the command set is the verb's, not the agent's memory.
- ADR 0092 — zero diff is a refusal, not a vacuous green.
- The gate's own answer (`ci.yml`) supersedes this verdict wherever they disagree; this verb
  predicts, the gate decides (interface convention rule 6).

---

## `build push`

**Invocation**

```
fabrika build push [--force-with-lease]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--force-with-lease` | boolean | no | `false` | permit a non-fast-forward update of this lane's own branch (repair resubmission) |

**Output** — machine, **single-stream: the entire report is stdout**, and the last line is always
exactly one of:

```
PUSH-VERDICT: MOVED
```

on exit 0. `NOT-MOVED` and `UNKNOWN` are exits `17` and `8` with empty stdout and the report on
stderr — so `tail -1` of stdout on exit 0 is always the verdict line. (v1 *documented* this idiom
and then both call sites redirected the report to stderr, so the documented `tail -1` never ran —
`SKILL.md:778-781` vs `step5-push.sh:47`. Here the channel is part of the contract.)

The protocol: resolve the checked-out lane branch and its **push target** — the tracked upstream
ref when one is set (the resume-mode case, where the local name `build/pr-<pr>-<nonce>` publishes
to the PR's remote head branch), else the branch's own name. Push to that target; then
**independently read the target ref on the remote** (`git ls-remote`) and compare against the
local SHA. `MOVED` requires positive evidence; a push that reported success over a target ref
that did not move is `17`; a probe that failed is `8`. Reading back the local *name* instead of
the push *target* would make every repair push a false `17` — the target is the one fact both
halves share.

Refusals before any push (`19`): HEAD is detached; or the update is non-fast-forward and
`--force-with-lease` was not given. `--force-with-lease` is the only force shape — a bare
`--force` flag does not exist here, and there is no `--no-verify` (#4159: the ban is enforced by
the flag not existing).

Preconditions: a linked worktree (`12`), the lane's branch (`14`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `8` | the push was attempted but the remote ref could not be re-read — the outcome is UNKNOWN (the matrix's `8`: an attempted write whose outcome cannot be proven) |
| `11` | the lane's claim could not be read — nothing was pushed |
| `12` | proven: not in a linked worktree |
| `14` | proven: the checked-out branch is not this lane's (lane-identity rule) |
| `15` | proven: the lane's claim is held by another session — nothing was pushed |
| `17` | proven: the remote ref did not move |
| `19` | refused before pushing: detached HEAD, or non-fast-forward without `--force-with-lease` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build push: HEAD is detached — refusing to guess a branch.` | 19 | refusal |
| `build push: non-fast-forward — pass --force-with-lease only for this lane's own repair resubmission.` | 19 | refusal |
| `build push: the remote ref did not move (remote <sha> ≠ local <sha>).` | 17 | refusal |
| `build push: pushed, but the remote ref could not be re-read: <reason> — the outcome is UNKNOWN.` | 8 | refusal |

**Scope** — one branch, one remote ref, read back independently of the push's own report.

**Example**

```
$ fabrika build push
pushed build/4312-editor-focus-loss-c1a4d6f8 → origin
remote ref read back: 03135b91
PUSH-VERDICT: MOVED
```

**Grounding**

- #4136 — a push that died mid-hook read as sent; the independent read-back is the design.
- #4468 — v1's `verified-push` could force-move a branch backward from a detached HEAD; the `19`
  refusal removes the case instead of guarding it.
- #4159 — `--no-verify` unenforceable as prose; here unrepresentable.
- #4540 — `--force-with-lease` as the only force shape protects the remote against a stale local.

---

## `build pr`

**Invocation**

```
fabrika build pr 4312 [--partial] <<'EOF'
…the authored body…
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the claimed issue this PR serves |
| `--partial` | boolean | no | `false` | the acceptance criteria are not all met: the body must say `Part of #<n>`, not `Fixes #<n>` |
| stdin | text | yes | — | the PR body |

**Output** — machine. One JSON object: `{"answer": "opened", "number": 4318, "url": "..."}` — or,
when an open PR for this head branch already exists (this lane's own, by claim),
`{"answer": "existing", "number": 4310, "url": "..."}` on exit 0: an idempotent re-run is an
answer, not an error.

The guards, in order, all before any write:

1. **stdin non-empty** (`3`).
2. **no machine-local path** — the imported `leaks.ts` predicates (`5`, `6`).
3. **body shape** (`4`): a `## Deviations` heading is present **and non-empty** — at least one
   non-blank line before the next heading or EOF; "None." is content, silence is not (the
   *truth* of the section stays the skill's — a verb can force the author to write, not to be
   honest); exactly one closing-keyword line, targeting `<number>` and matching `--partial`
   (`Fixes #4312` without `--partial`, `Part of #4312` with it); no second closing keyword aimed
   at any other issue (#4471's stray auto-close).
4. **no forbidden classification** (`10`), by a closed pattern set, checked outside code fences
   and block quotes: `/(not[ -])?control[ -]plane/i` (the §CP assertion class, #4153), a
   `type:<word>` label assertion, and a standalone `p[0-3]` priority assertion. The merge gate
   and triage own those verdicts. The pattern set is closed on purpose: two implementers must
   ship the same guard, and a "any spelling" instruction is two guards.
5. **claim confirmed** (`15`/`11`), **target issue open** (`7`).

Then create, **re-read the created PR**, and compare body through `normalizeForReadback` (`9` on
mismatch). The write path is `gh api` with the body from a file — never `-f body=@file`, which
posts the literal string (#4683).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin held nothing |
| `4` | `## Deviations` missing or empty, or the closing-keyword line is absent, duplicated, mistargeted, or contradicts `--partial` |
| `5` | the body carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `7` | the issue is proven absent or closed |
| `8` | the create failed — it may or may not have landed; re-run (the verb re-checks for an existing PR first) |
| `9` | the PR landed but the read-back body does not match |
| `10` | the body carries a control-plane (or type/priority) classification claim |
| `11` | a precondition read failed |
| `12` | proven: not in a linked worktree |
| `14` | proven: the checked-out head branch is not this lane's |
| `15` | proven: this session does not hold the claim |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build pr: stdin held nothing — the body is the input.` | 3 | refusal |
| `build pr: the body has no "## Deviations" heading, or it is empty — state deviations, or state "None."` | 4 | refusal |
| `build pr: the body says "Fixes #<n>" but --partial was given — a partial PR must say "Part of #<n>".` | 4 | refusal |
| `build pr: the body carries a closing keyword aimed at #<m> — this PR serves #<n>.` | 4 | refusal |
| `build pr: the body carries a machine-local path: <first hit> — redact before posting.` | 5 | refusal |
| `build pr: the body is a bare @ path reference — write the body, not a pointer to it.` | 6 | refusal |
| `build pr: issue #<n> is proven absent or closed.` | 7 | refusal |
| `build pr: the create failed: <reason> — it may or may not have landed; re-run, the verb re-checks for an existing PR first.` | 8 | refusal |
| `build pr: the PR landed (#<m>) but its body does not read back as sent — it needs a human eye.` | 9 | refusal |
| `build pr: the body asserts a control-plane classification — that verdict is the merge gate's.` | 10 | refusal |
| `build pr: cannot read <what>: <reason> — nothing was written.` | 11 | refusal |
| `build pr: #<n> is held by <token>, not this session.` | 15 | refusal |

The `12`/`14` tree-precondition messages are `build tree`'s rows with the verb name substituted
(shared conventions).

**Scope** — one PR create against one issue. The head branch is the checked-out one; its nonce
must match the claim (`14` via the shared precondition).

**Examples**

```
$ fabrika build pr 4312 <<'EOF'
Fixes #4312

Editor focus now survives a save: the toolbar re-render no longer steals it.

## Deviations
None.
EOF
{"answer":"opened","number":4318,"url":"https://github.com/kamp-us/phoenix/pull/4318"}
```

```
$ printf 'Fixes #4312\n\nbody with no deviations heading\n' | fabrika build pr 4312
build pr: the body has no "## Deviations" heading, or it is empty — state deviations, or state "None."
$ echo $?
4
```

**Grounding**

- #4542 — the Deviations check must block, not warn.
- #4471 — a stray closing keyword auto-closed an issue the PR did not fix.
- #4153 — a false control-plane negative shipped in a PR body; the claim is now unrepresentable.
- #4683 / #3086 — the `-f body=@file` literal and the temp-path leak; both guarded here.
- #4544-class — idempotent `existing` answer instead of a duplicate PR on a re-run after `8`.

---

## `build note`

**Invocation**

```
fabrika build note 4312 [--repo <owner/name>] <<'EOF'
…the progress / handoff note…
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the issue or PR the note posts to — resolved via the REST issues endpoint, whose response carries a `pull_request` key exactly when the number is a PR; the head stamp applies only then |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository written to |
| stdin | text | yes | — | the note body |

**Output** — machine. `{"answer": "posted", "number": 4312, "commentId": 512345, "head": "03135b91"}`.
When the target resolves to a PR, the note is **stamped with the PR's current head SHA at post
time** (appended as a final line `— at 03135b91`); a reader can see at a glance that a note
predates a later push — the stale-repair-note class (#4808) made a spot judgment carry no
freshness signal at all.

Guards: stdin non-empty (`3`), leak predicates (`5`, `6`), claim confirmed (`15`/`11`), target
open (`7`), read-back through `normalizeForReadback` (`9`), write-unknown (`8`).

**Exit status** (beyond the universal four): `3`, `5`, `6`, `7`, `8`, `9`, `11`, `15` — triggers
exactly as in `build pr`, minus the body-shape and classification rows (`4`, `10` are
unreachable: a note has no required sections and no closing keywords; a classification *claim* in
a note is prose the reader weighs, not a label the board consumes).

**Errors** — `build pr`'s rows for `3`, `5`, `6`, `8`, `9`, `11`, `15` with the verb name
substituted (shared conventions), plus:

| Message (stderr) | Code | Kind |
|---|---|---|
| `build note: #<n> is proven absent or closed — nothing to post to.` | 7 | refusal |

**Example**

```
$ fabrika build note 4310 <<'EOF'
Round 2 findings addressed: focus restore moved out of the render path.
EOF
{"answer":"posted","number":4310,"commentId":512346,"head":"03135b91"}
```

**Grounding**

- #4808 — the stale-note class; the head stamp is the design.
- #3086 — leak guards on everything posted.
- Closed-vocabulary coordination (secure-by-default AC 5): the note is prose *on the artifact*;
  any cross-lane signal names kind + action + this branded ref, and the receiver re-fetches.

---

## `build verdicts`

**Invocation**

```
fabrika build verdicts --pr 4310 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request whose verdict state is folded |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository read |

**Output** — machine. One JSON object:

```
{"head": "03135b91", "rows": [
   {"gate": "review-code", "polarity": "FAIL", "sha": "03135b91", "current": true,
    "commentId": 512001, "kind": "marker", "body": "review-code: FAIL @ 03135b91 — the debounce fix races the unmount; see inline notes."},
   {"gate": "native-review", "polarity": "CHANGES_REQUESTED", "sha": null, "current": null,
    "reviewId": 98001, "kind": "native", "body": "…the review's text…"}
 ],
 "rounds": 2, "capReached": false,
 "frozenCriteria": [{"text": "add an e2e for the empty-list case", "appendedRound": 3}]}
```

(`frozenCriteria` rows carry `text` and `appendedRound`; the array is empty when nothing was
appended after round 2. **Each row's `body` is the finding's full text, passed through the
content gate** — the repair loop consumes findings from here and never raw-fetches a comment,
which is what keeps AC 3's one-door property over the repair path. `capReached` is
`rounds >= 3`, computed here so the cap is a field read, not a number remembered.)

The fold: resolve the PR's current head; fetch **every** comment and **every** review, paginated
in full; parse each comment through the imported `verdict-marker` read; keep the latest marker
per gate namespace; bind each to the current head (`current: true|false` — a stale marker is
visible *as stale*, never dropped, because "the FAIL is old" and "there is no FAIL" are different
facts, #4105's class). **Native reviews are their own row kind**, not coerced into markers —
whether a `CHANGES_REQUESTED` with no marker drives a repair is the open decision #4555; this
verb reports the state honestly and pre-rules nothing. `rounds` counts distinct FAIL clusters by
the 120-second gap rule computed over the *full* comment set (v1 counted off a truncated 100-
comment snapshot, `stepR-round-count.sh` + `stepR1-verdicts.sh:48`; the off-by-one at the cap is
#4570 — the count here is covered by a unit test at the boundary). **The rule, exactly:** take
every FAIL-polarity marker comment, sorted by `created_at` ascending; a marker whose gap from
the previous FAIL marker exceeds 120 seconds starts a new cluster, a gap of exactly 120 seconds
or less continues the current one; `rounds` is the cluster count. `frozenCriteria` lists
review-appended acceptance-criterion rows dated after round 2.

**`{"rows": [], ...}` on exit 0 is a proven "no verdicts", readable against the scope line's
comment/review counts. An unreadable page is `11` — never a shorter list.** All content passes
the content gate.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent or closed |
| `11` | the head, any comment page, or any review page could not be read — the fold is UNKNOWN, never partial |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `build verdicts: PR #<n> is proven absent or closed.` | 7 | refusal |
| `build verdicts: cannot read <what> (page <k>): <reason> — the verdict state is UNKNOWN, never "none".` | 11 | refusal |

**Scope** — one PR: its head, all comments, all reviews. The stderr scope line names the head SHA
and both counts, so an empty `rows` is auditable as "N comments read, none carried a marker".

**Example**

```
$ fabrika build verdicts --pr 4310
{"head":"03135b91","rows":[{"gate":"review-code","polarity":"FAIL","sha":"03135b91","current":true,"commentId":512001,"kind":"marker","body":"review-code: FAIL @ 03135b91 — the debounce fix races the unmount; see inline notes."}],"rounds":1,"capReached":false,"frozenCriteria":[]}
```

**Grounding**

- #4105 — a FAIL visible on the PR read back as "none"; polarity and staleness are both explicit
  here.
- #4926-class / `stepR1-verdicts.sh:48` — un-paginated comment reads truncated the fold's input.
- #4570 — the round-count boundary condition, pinned by a required unit test.
- #4555 (open decision) — native-review rows are reported as their own kind, never coerced;
  the ruling lands as a change to the *skill's* routing, not to this verb.
- ADR 0092 / #4208 / #4219 — a proven-empty fold and an unreadable fold sit on different codes.

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag above
carries a type and default; every stdout shape has a literal example; every non-zero code is
enumerated with its trigger (per-verb tables own `3`+; the universal `0/1/2/127` are stated once
in the shared matrix, which owns every code's single meaning); every error names message, stream,
and code; every judging verb states scope and zero-scope behavior; and no clause defers to a v1
script, another skill's prose, or the authoring session. The three hand-checks the brief's
lineage demands: every reachable outcome above was walked against its verb's failure modes; every
example value is derivable from its verb's stated rules (the nonce from the claim token, the
verdict line from the protocol); and sibling verbs guard shared preconditions identically
(`branch`/`check`/`push` run `tree`'s assertions; `pr`/`note` run the same posting guards on the
same codes).
