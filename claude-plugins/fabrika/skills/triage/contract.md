# `/triage` — derived CLI contract

**Skill:** [`triage`](SKILL.md) · **Authoring brief:** [#4706](https://github.com/kamp-us/phoenix/issues/4706) · **Date:** 2026-08-02

These verbs live in `packages/fabrika-cli/`, binary `fabrika`, grouped under a `triage` subcommand,
beside the `adr`, `report` and `eval` groups already implemented there. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs them; where this spec and
that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every verb below
is implemented from scratch here. v1's tools and its 18 `scripts/` were read for their semantics and
their scars — each Grounding section names what the v1 counterpart gets wrong and what this spec does
instead — but no clause defers to one, and none is invoked.

**Substrate.** These verbs are Effect CLI verbs on the `@effect/platform-node` seam already used by
the sibling groups; GitHub access goes through the same `gh api` REST shape, never GraphQL (the org's
Projects-classic integration breaks GraphQL issue queries). Named here because
`cli-interface-convention.md` states no substrate and a spec that leaves it open makes the
implementer guess ([#4734](https://github.com/kamp-us/phoenix/issues/4734)).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `triage queue` | the claimable `status:needs-triage` queue, with the count it scanned | paginating a label query and separating a proven-empty queue from a failed read is mechanical; which issue to take is judgment |
| `triage claim` | take a session-scoped claim on one issue, proven by read-back | a marker write plus an earliest-claim tiebreak is a protocol, not a decision |
| `triage provenance` | was this issue filed by an agent or hand-typed by a human | a structural marker test over a fetched body, fail-closed to `human`; what to *do* about a human filing stays in the skill |
| `triage homes` | the assignable homes — open milestones joined to their ROADMAP rows, plus the standing lanes | the join and the open-milestone filter are mechanical; picking which home fits is judgment |
| `triage split` | create one split child, once, keyed on the parent back-reference | idempotency keyed on a durable reference is mechanical; deciding a report *is* a bundle is judgment |
| `triage enrich` | replace the body with your rewrite over a preserved, leak-redacted original | envelope assembly, redaction and read-back are mechanical; what the rewrite says is judgment |
| `triage apply` | apply the whole triaged transition — type, priority, audience, home — and read it back | closed-vocabulary validation and an atomic label envelope are mechanical; the classification is judgment |
| `triage park` | park a human-filed issue on `status:needs-info` with questions | the label swap and comment are mechanical; the questions are judgment |
| `triage kill` | close an agent-filed issue not-planned, auditably, preserving a duplicate's content | the three-write envelope, the redacted fold and the human-filed refusal are mechanical; the verdict is judgment |

One existing verb gains one flag:

| Change | Why |
|---|---|
| `report dedup` gains `--exclude <number>` | The [`/report` contract](../report/contract.md) deliberately omitted it — *"it exists for the triage seam, where the issue being deduped already exists and must not flag itself; this skill's dedup runs before its issue exists, so the flag would have zero callers."* This is that seam, and this is its first caller. Minting a second dedup verb here would duplicate a 200-line tokenizer to add one filter. |

### Considered and deliberately not derived

Each is a real proposal someone could make again, so it is recorded rather than left to be
re-litigated. (Conventions §7 puts rejections in a plugin-root `.out-of-scope/`, which does not yet
exist for any fabrika skill; these live here until it does.)

- **A `triage homing-check` verb.** `homing-guard` is CI-enforced on `issues: [labeled, unlabeled,
  milestoned, demilestoned]` (`.github/workflows/homing-guard.yml`) — it fires on the exact label
  write `triage apply` makes. A fabrika copy could only agree redundantly or disagree with the
  enforced verdict. `apply` instead takes the home as a **required input**, so an un-homed
  `status:triaged` is unrepresentable rather than detected after the fact. That is a precondition,
  not a second verdict.
- **A `triage pitch-check` verb.** Same shape: `.github/workflows/pitch-guard.yml` fires on
  `issues: [labeled]` filtered to `status:triaged`. Worse, v1's wrapper *reds on its own expected
  case* — an unapproved pitch is the normal state of freshly-triaged work and resolves to
  `pass: false` → exit 1, so the happy path always looks like a failure. The skill drafts the pitch
  and lets the seam gate answer.
- **A `triage classify-cp` verb.** `cp-classify` routes the control-plane question and CODEOWNERS
  enforces it at merge. #4227 is precisely the cost of a triage-side second opinion: a routing note
  asserted the opposite of a settled ruling and a lane was planned around an approval that never
  fires. The skill states the expectation and asserts nothing.
- **A `triage release-claim` verb.** v1 needed one because its claim was an assignee and
  `write-code`'s picker skipped assigned issues. Audience now rides on `ready-for:` (#4780), so
  nothing about a claim blocks pickup, and the marker expires on a TTL (see `triage claim`). A verb
  whose whole body is one `DELETE` is the wrapper ADR 0238 bans.
- **A `triage milestone-hygiene` verb** (v1's 100%-open flag). Its answer is a board-hygiene signal
  for a human, not an input to triaging an issue; it belongs to a roadmap surface, not this skill.
- **A `resolve-repo` verb.** v1's exists only to feed hand-rolled `gh api` calls in the skill body.
  This skill has no such surface: repo resolution is a shared input on every verb below.

### The name collision with v1's `triage` is live, not dormant

**A skill named `triage` already exists** at `claude-plugins/kampus-pipeline/skills/triage/`, it is
model-invoked, and its six triggers are near-identical to this one's. The `/report` contract recorded
the analogous collision as "dormant only by configuration — `.claude/settings.json` has
`"kampus-pipeline@kampus": false`". **That reasoning does not hold.** `.claude/skills` is a symlink to
`claude-plugins/kampus-pipeline/skills`, so v1's skills load as *project-level* skills and the plugin
toggle does not stop them: a live session's roster carries both `adr` and `fabrika:adr`, and both
`report` and `fabrika:report`. Filed as #4829; the adjacent routing-pin half is #4761.

So this collision is **stronger** than `report`'s (same name, same plugin-relative role, nearly
identical triggers) and its stated mitigation is inert. Two things follow, and neither is optional:

- **This skill is model-invoked deliberately** (conventions §3): triage must fire when someone says
  "triage the queue" without naming a plugin, and other skills must be able to reach it. It therefore
  pays the context load, and the description is the discriminator — it names the audience label, the
  read-back, and the guardrail framing that v1's cannot.
- **Retiring v1's description is cutover work, not this brief's** (v1 is the frozen baseline, #4631 /
  ADR 0238). Until it happens the bare name resolves to v1 and this skill is reached as
  `/fabrika:triage`. Stated here so a reader meets it as a known state rather than a surprise.

### Nothing here recomputes an enforced answer

Every question this group answers is ungated. The three that *are* enforced — homing, pitch, and
control-plane membership — are listed above as deliberately underived, with the workflow file that
owns each. This spec computes no second verdict on any of them.

## Shared conventions

Stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else. Scope lines, refusal
  reasons, redaction notices and progress go to stderr.
- **The positive answer is a state word, never an absence.** Every verb's "nothing found" case prints
  a token. Empty stdout is byte-identical to a verb that never ran, and consuming it as a proven
  negative is the single most damaging defect class in v1: `split-guard` prints `#n` or nothing, and
  v1's caller reads stdout only — so a `gh` failure reads as "safe to create" and fires the twin the
  guard exists to prevent.
- **Common inputs.** `--repo <owner/name>` (default: `$CLAUDE_PIPELINE_REPO`, else
  `$GITHUB_REPOSITORY`, else the `origin` remote's `owner/name`); with none resolvable the verb exits
  1 rather than guessing. `--json` swaps the line grammar for one JSON object with the named keys.
- **Every list read paginates and reports its scanned count** on stderr. v1 lost home candidates past
  GitHub's default page of 30 and truncated the queue at 100 with no signal; a verdict driven by a
  silently truncated read is a verdict over unknown scope.
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero exit.

### The shared exit taxonomy

All nine verbs allocate from **one table**, so a code means the same thing whichever produced it. A
verb that cannot reach a code leaves it unused rather than compacting the range — a gap is cheaper
than a collision.

| Code | Meaning | queue | claim | prov | homes | split | enrich | apply | park | kill |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, unresolvable repo, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `2` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | — | — | — | ✓ | ✓ | — | ✓ | ✓ |
| `4` | the target issue does not exist, or is not readable | — | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `5` | the **authored** text carries a machine-local path | — | — | — | — | ✓ | ✓ | — | ✓ | ✓ |
| `6` | *(unallocated — see `triage claim`)* | — | — | — | — | — | — | — | — | — |
| `7` | the read succeeded over **zero scope**, or a required label vocabulary is absent — a fail-closed refusal | ✓ | — | — | ✓ | — | — | ✓ | ✓ | ✓ |
| `8` | the write itself failed — the outcome is **UNKNOWN** | — | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `9` | the write landed but the read-back does not match | — | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `10` | an off-vocabulary value was supplied, or names a non-open milestone | — | — | — | — | — | — | ✓ | — | — |
| `11` | refused: the issue is human-filed | — | — | — | — | — | — | — | — | ✓ |
| `12` | refused: agent-filed and close-eligible, but the kill is unconfirmed (ADR 0159) | — | — | — | — | — | — | — | — | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**`7` means the same thing across groups, and this was checked against the shipped binary rather than
against a document.** `fabrika report dedup --help` at `v0.1.0` states it "Exits … 7 (`--label` does
not exist, so the queue half would scan nothing)" — a zero-scope refusal. `triage queue` and
`triage homes` use `7` for exactly that: the scope the verb would have scanned does not exist. (The
checked-in [`/report` contract](../report/contract.md) lists only `0/1/3/4` and is therefore behind
its own implementation on this point; the binary is the authority, and the drift is noted in this
skill's handoff rather than silently copied.)

**`8` and `9` are deliberately not `1`.** A create or PATCH that times out may or may not have
landed; seating that on `1` makes "GitHub refused the write" indistinguishable from "the binary is
broken", which is the verdict-versus-invocation collision the reserved range exists to prevent. Each
`8` message carries its recovery instruction, because a blind retry is how one split becomes two
children.

**`5` applies only to text the caller just wrote, never to content being preserved.** Authored text
is refusable because the author can fix it; foreign content being copied forward is **redacted
automatically**, because refusing it would strand the operation on somebody else's mistake. This
asymmetry is the whole of the leak design and it is stated once here.

### Read-backs compare normalized text, not bytes

Every write verb re-reads its target and compares. The comparison is **normalized**: line endings to
`\n`, and trailing whitespace on each line stripped, before equality. GitHub is not documented to
round-trip a body byte-for-byte, and an unverified byte-identity assumption would fire exit `9` on
every clean run. The normalization is specified here rather than assumed, and the implementer should
confirm it against the live API before relying on a tighter comparison.

### Machine-local path detection

`triage enrich`, `triage kill`, `triage split` and `triage park` share the leak predicate **already
implemented** at `packages/fabrika-cli/src/report/leaks.ts` — three structural shapes (home-relative
`~/`, absolute home root `/Users/<account>` and `/home/<account>`, and the temp roots `/tmp`,
`/private/tmp`, `/private/var`, `/var/folders`), no name list, each redacting to its class root, and
specified in full in the [`/report` contract](../report/contract.md).

**Import that module; do not re-derive the predicate.** Naming the module rather than the document is
deliberate — a prose pointer is a deferral, and a second leak predicate that drifts from the first is
worse than either alone. The same applies to the dedup core at
`packages/fabrika-cli/src/report/dedup.ts`, which the `--exclude` extension modifies rather than
copies.

---

## `triage queue`

**Invocation**

```
fabrika triage queue [--label <name>] [--limit <n>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--label` | string | no | `status:needs-triage` | the intake-queue label whose open issues form the queue |
| `--limit` | integer | no | `100` | the maximum number of rows to print; must be ≥ 1 |
| `--repo` | string | no | resolved (see Shared conventions) | the repository to read |
| `--json` | boolean | no | `false` | emit the full result object instead of the line grammar |

**Output** — machine channel. The first line is the outcome token alone: `queued` or `empty`. On
`queued`, one **tab-separated** line per issue follows — `<number>`, `<age-days>`, `<title>` — oldest
first, capped at `--limit`. `<age-days>` is a whole number of days from the issue's `created_at` to
now, floored.

With `--json`, one object with keys `outcome`, `issues` (array of `{number, ageDays, title}`, empty
unless `outcome` is `queued`), `scanned` (integer), and `truncated` (boolean).

Pull requests are excluded: GitHub's issues endpoint returns them, and v1's listers did not filter,
so a PR could appear as a triageable row.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `queued` or `empty` was produced on stdout |
| `1` | usage error, `--limit` below 1, unresolvable repo, or the verb failed to run |
| `2` | no implementation could be resolved |
| `7` | the label does not exist in the repository — zero scope, a refusal |
| `127` | the verb never ran (unresolved binary) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage queue: cannot read the <label> queue in <repo>: <reason> — the outcome is UNKNOWN, never "empty".` | 1 | refusal |
| `triage queue: label <label> does not exist in <repo> — refusing to report an empty queue over zero scope (ADR 0092).` | 7 | refusal |
| `triage queue: --limit must be 1 or greater.` | 1 | usage error |

**Scope** — every open issue in `--repo` carrying `--label`, read with pagination. **`empty` and a
failed read are different answers and never share a channel or a code.** The distinction is
load-bearing because the skill uses this verb as a sweep's termination test: a renamed label or a
scope-limited token returns HTTP 200 with `[]`, and v1 terminated the sweep on it and reported the
queue drained. The label's existence is checked against the repository's label set, so a typo reds on
`7` rather than answering `empty`. The scope line on stderr names the scanned count on every run.

**Examples**

```
$ fabrika triage queue
queued
4312	3	Sozluk definition editor loses focus after an entry is saved
4290	11	Retry helper swallows the abort reason
```

```
$ fabrika triage queue --label status:needs-triage
empty
$ echo $?
0
```

```
$ fabrika triage queue --label status:needs-triage-typo
triage queue: label status:needs-triage-typo does not exist in kamp-us/phoenix — refusing to report an empty queue over zero scope (ADR 0092).
$ echo $?
7
```

```
$ fabrika triage queue --json
{"outcome":"queued","issues":[{"number":4312,"ageDays":3,"title":"Sozluk definition editor loses focus after an entry is saved"}],"scanned":1,"truncated":false}
```

**Grounding**

- ADR 0092 — a read whose scope is zero reds rather than answering. v1's `list-queue.sh` had no such
  check and its empty output *was* the sweep's termination test.
- v1 `list-queue.sh` prints `(.user.login)` on every row — the filer. ADR 0159 makes authorship
  unusable, since every report-filed issue shows the same account. This verb omits it, and
  `triage provenance` answers the question that field pretends to.
- v1 paginated neither this read nor `list-open-milestones.sh`; the latter silently capped home
  candidates at GitHub's default 30 while "nothing fits" routed to a standing lane or a kill.

---

## `triage claim`

**Invocation**

```
fabrika triage claim 4312 [--ttl-minutes <n>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue number to claim |
| `--ttl-minutes` | integer | no | `60` | how long an existing claim marker stays binding before it is treated as abandoned |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `won`, or `lost\t<holder-session-id>`. **Both are proven
answers and both exit 0**, with the discriminator in the state word — the same three-outcome shape
`report dedup` already uses. A losing claim is something this verb *determined*, not something that
prevented it from answering, so seating it on a non-zero code would contradict the shared rule that a
non-zero exit is UNKNOWN and would make "another sweep holds it" indistinguishable from "the verb is
broken".

With `--json`, an object with keys `outcome` (`won` / `lost`), `session` (this session's id),
`holder` (the winning session id, `null` on `won`), `markers` (count of live markers considered), and
`expired` (count discarded as older than the TTL).

**The marker literal.** A claim is one issue comment whose body is exactly:

```
<!-- fabrika-triage-claim session=<session-id> -->
```

One line, no surrounding prose, so a marker is matched by an exact prefix rather than by parsing
human text. `<session-id>` is the verbatim value of `$CLAUDE_CODE_SESSION_ID`. Any comment not
matching that prefix is not a marker and is ignored.

**The ordering key is the comment's `created_at` as returned by GitHub**, never a timestamp embedded
in the marker text: the body is caller-supplied and a caller could backdate itself into winning every
race. "Older than `--ttl-minutes`" is measured against that same `created_at`. Earliest surviving
marker wins.

**The claim is a session-stamped comment, never the assignee.** Every agent authenticates as the same
login, so the assignee field cannot discriminate two concurrent sweeps — it is a shared availability
slot (#4780, and v1's own `claim-assign.ts` says as much: *"every agent authenticates as the same
login, so the assignee is one shared slot"*). The session id comes from `$CLAUDE_CODE_SESSION_ID`; with it
unset the verb exits `1` rather than posting an unattributable marker.

**Resolution.** Post this session's marker, re-read all markers on the issue, discard any older than
`--ttl-minutes`, and the **earliest surviving marker wins**. `won` requires a positive proof that the
winner is this session; every unresolvable state answers `lost`, never `won`.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `won` **or** `lost` was produced on stdout — both are proven answers |
| `1` | usage error, `$CLAUDE_CODE_SESSION_ID` unset, unresolvable repo, or the verb failed to run |
| `2` | no implementation could be resolved |
| `4` | the issue does not exist, or is closed |
| `8` | the marker write failed — the outcome is UNKNOWN |
| `9` | the marker was posted but the read-back does not find it |
| `127` | the verb never ran (unresolved binary) |

`6` is deliberately **unused** by this verb. It was allocated to `lost` in an earlier draft, which
put an answer on stdout at a non-zero exit; the code is left as a gap rather than reassigned, because
a gap is cheaper than a collision.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage claim: CLAUDE_CODE_SESSION_ID is unset — refusing to post an unattributable claim.` | 1 | refusal |
| `triage claim: issue #<n> not found in <repo>.` | 4 | refusal |
| `triage claim: issue #<n> is closed — nothing to triage.` | 4 | refusal |
| `triage claim: #<n> is held by session <holder> since <created_at> — backing off.` | 0 | notice |
| `triage claim: marker POST failed: <reason> — UNKNOWN whether it landed; re-run before mutating #<n>.` | 8 | refusal |
| `triage claim: marker posted but absent on read-back — treating the claim as lost.` | 9 | refusal |

**Scope** — the issue's comments, paginated, filtered to the marker prefix. A comment read that fails
is exit `1`; it never degrades to `won`. Session ids are printed **in full** on both channels — there
is no abbreviation rule — because a truncated id cannot be compared against `$CLAUDE_CODE_SESSION_ID`
by a caller.

**Examples**

```
$ fabrika triage claim 4312
won
```

```
$ fabrika triage claim 4312
triage claim: #4312 is held by session 7f3c-9a20-4b11-8e05-1d77c2a4f9be since 2026-08-02T09:14:02Z — backing off.
lost	7f3c-9a20-4b11-8e05-1d77c2a4f9be
$ echo $?
0
```

```
$ fabrika triage claim 4312 --json
{"outcome":"won","session":"b2e1-4c07-4a99-9f30-55da1e6b7c02","holder":null,"markers":1,"expired":0}
```

**Grounding**

- v1 `claim-issue.sh:29` reads `ME=$(gh api user --jq '.login')` unguarded. With a broken token `ME`
  is empty, every comparison against it is `"" = ""` → true, and the script prints `claim: won` and
  **exits 0** — a fail-open claim on a token that cannot write. `won` here requires positive proof.
- v1 `claim-issue.sh:35-36` cannot distinguish "unassigned" from "the read failed": both are the
  empty string, and the empty string means free-to-claim.
- v1 `claim-issue.sh:51` `DELETE`s other accounts' assignments, so a human self-assigning inside the
  race window loses it to a string comparison. This verb writes only its own marker and removes
  nothing.
- #4780 — audience moved to `ready-for:`, so a claim no longer has to be released to keep an issue
  pickable. The TTL replaces v1's mandatory release, whose script swallowed every error
  (`2>/dev/null || true`) and could silently leave an issue unpickable forever.

---

## `triage provenance`

**Invocation**

```
fabrika triage provenance 4312 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue number to inspect |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `agent` or `human`. With `--json`, an object with keys
`outcome`, `marker` (boolean — was the agent footer present), and `reason`.

**The signal is the `Filed by an agent` footer, not the author.** Every report-filed issue shows the
same account, so authorship carries no information (ADR 0159). The footer's session and model fields
are best-effort and often absent; the literal marker string is the invariant, and a sparse footer is
still a footer.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `agent` or `human` was produced on stdout |
| `1` | usage error, unresolvable repo, or the verb failed to run |
| `2` | no implementation could be resolved |
| `4` | the issue does not exist |
| `127` | the verb never ran (unresolved binary) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage provenance: issue #<n> not found in <repo>.` | 4 | refusal |
| `triage provenance: #<n> has an empty body — answering human (fail-closed).` | 0 | notice |

**Scope** — one issue body. **A body that is absent, empty, or unreadable answers `human`**, because
the only irreversible act downstream is a kill and the protective default is the one that refuses it.
This is a fail-closed default, not a measurement, and it says so on stderr so a caller can tell a
measured `human` from a defaulted one. The verb fetches the body as typed JSON rather than through
`jq -r .body`, which errors on the unescaped control characters GitHub issue bodies carry and yields
empty in a loop.

**Examples**

```
$ fabrika triage provenance 4312
agent
```

```
$ fabrika triage provenance 4290
human
```

```
$ fabrika triage provenance 4312 --json
{"outcome":"agent","marker":true,"reason":"the 'Filed by an agent' marker is present in the body"}
```

**Grounding**

- ADR 0159 — filing provenance, not authorship, is the signal.
- v1 has **no tool for this at all**: "never close a human-filed issue" is 48 lines of prose across
  `SKILL.md` and `close-not-planned.md`, with nothing computing it, while `list-queue.sh` puts the
  meaningless filer login in front of the agent on every row. The highest-stakes, least-reversible
  decision in the skill had the least support.
- `triage kill` re-checks this itself rather than trusting a caller to have run it — the guard is
  structural, not a caller's discipline.

---

## `triage homes`

**Invocation**

```
fabrika triage homes [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. The first line is the outcome token `homes`. Then one tab-separated
line per candidate — `<kind>`, `<key>`, `<label-or-title>` — where `<kind>` is `milestone` or `lane`.
A `milestone` row's `<key>` is its **number** (the value `triage apply --home` takes) and its third
column is the milestone title; a `lane` row's `<key>` is its label name and its third column is a
fixed string, exactly one of:

| Lane | Third column, verbatim |
|---|---|
| `wayfinder:backlog` | `fog — uncharted work upstream of any arc` |
| `axis:pipeline-hardening` | `the standing pipeline and reliability lane` |

Milestone rows come first, ordered by number, then the two lanes. The lane strings are constants in
this spec rather than the repo's live label descriptions, so a description edit cannot change a
machine-channel answer.

With `--json`, an object with keys `outcome`, `milestones` (array of `{number, title, roadmapRow}`),
`lanes` (array of `{label, meaning}`), and `scanned`.

**Only open milestones appear, and each is joined to its `ROADMAP.md` arc/campaign row.**
`roadmapRow` is `null` for an open milestone no roadmap row pins, which is itself a signal worth
seeing rather than a row to hide. The two standing lanes are fixed and are not read from the repo:
`wayfinder:backlog` and `axis:pipeline-hardening`. There is no third, and this verb never invents one.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the candidate list was produced on stdout |
| `1` | usage error, unresolvable repo, `ROADMAP.md` unreadable, or the verb failed to run |
| `2` | no implementation could be resolved |
| `7` | the repository has zero open milestones, **or `ROADMAP.md` parsed to zero arc rows** — zero scope, a refusal |
| `127` | the verb never ran (unresolved binary) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage homes: cannot read milestones in <repo>: <reason>.` | 1 | refusal |
| `triage homes: cannot read ROADMAP.md at <path>: <reason>.` | 1 | refusal |
| `triage homes: <repo> has 0 open milestones — refusing to answer, since "no home exists" routes to a kill (ADR 0092).` | 7 | refusal |
| `triage homes: ROADMAP.md parsed to 0 arc rows — the table grammar changed or the file is truncated; refusing to answer over an unjoinable roadmap.` | 7 | refusal |

**A readable `ROADMAP.md` that yields zero arc rows is a failed parse, not a repo with no arcs.**
The grammar is a table this verb does not own, so a grammar change silently empties the join; reading
that as "no homes exist" would route work to a kill. Zero *campaign* rows is a legitimate state and
passes.

**Scope** — every open milestone in `--repo`, paginated, joined to the `## Arcs` and `## Campaigns`
tables of `ROADMAP.md`, read from the repo root the delivery layer already sets as the process cwd
(see the CLI convention's Delivery section); `--roadmap <path>` overrides it. **Zero open milestones
is a refusal, not an answer**: an empty candidate list routes the skill toward a standing lane or a
kill, and a kill driven by a failed read is irreversible.

**On a `7` refusal stdout is empty and `--json` emits nothing** — the two lane constants go to stderr
with the refusal message. An earlier draft printed the lanes on stdout while withholding the outcome
token; that is a partial answer at a non-zero exit, which the shared conventions forbid and which
hands a byte-reading caller two rows and no token.

**Examples**

```
$ fabrika triage homes
homes
milestone	47	Sözlük — search and discovery
milestone	52	Merge-Gate Reliability
lane	wayfinder:backlog	fog — uncharted work upstream of any arc
lane	axis:pipeline-hardening	the standing pipeline and reliability lane
```

```
$ fabrika triage homes --json
{"outcome":"homes","milestones":[{"number":47,"title":"Sözlük — search and discovery","roadmapRow":"Geçit"},{"number":52,"title":"Merge-Gate Reliability","roadmapRow":null}],"lanes":[{"label":"wayfinder:backlog","meaning":"fog — uncharted work upstream of any arc"},{"label":"axis:pipeline-hardening","meaning":"the standing pipeline and reliability lane"}],"scanned":2}
```

**Grounding**

- v1 `list-open-milestones.sh:11` issues `gh api "repos/$REPO/milestones?state=open"` with no
  `per_page` and no `--paginate`, capping candidates at GitHub's default 30 with no truncation
  signal — while "nothing fits" routes to an irreversible kill.
- v1 made the agent join milestones to `ROADMAP.md` by hand from two sources, one of them silently
  truncated. The join is mechanical, so it belongs here.
- v1's `homing-guard` treats "homed" as `milestone !== null` and never checks the milestone is open or
  on-roadmap, so a closed milestone reports as a valid home. Offering only open, roadmap-joined
  milestones designs that mismatch out at the point of assignment rather than detecting it later.
- ADR 0072 §3 — curating the milestone set is a human roadmap act, so no verb here creates one.

---

## `triage split`

**Invocation**

```
fabrika triage split 4312 --title "Editor loses focus after save" [--repo <owner/name>] [--json]
```

The child body arrives on **stdin only**. There is no `--body` and no `--body-file`: a flag that
takes a path turns the body into a string the verb could post verbatim, which is how a machine-local
path reaches a public issue while the poster reads success. A shell redirect is expected — the
*shell* reads the file, so what reaches the verb is already bytes.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the parent issue this unit is split from |
| `--title` | string | yes | — | the child's single-unit title; also half the create-once key |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One tab-separated line: `<outcome>`, `<number>`, `<url>`, where
`<outcome>` is `created` or `reused`. With `--json`, an object with keys `outcome`, `number`, `url`,
`matchedOn` (`"back-reference+title"` on `reused`, `null` on `created`), and `crossLinked` (boolean).

**What the operation does, in order.** (1) Read the scope below. (2) On a match, print `reused` and
stop — **the existing child's body is not updated from stdin**, because a reuse is an idempotency
answer, not an edit, and silently rewriting a child someone may have already triaged would lose their
work. (3) On no match, append `split from #<parent>` to the stdin body and create the child. (4)
Post a `split into #<child>` comment on the parent.

**Step 4 is best-effort and never changes the exit status.** A failed cross-link is reported on
stderr; the child exists either way, and mapping it to `8` would be a lie, since `8` means the create
outcome is unknown and here the create demonstrably landed. The durable trace is the child's own
back-reference, which is the key the guard reads; the parent comment is for human readers.

**Both outcomes are answers and both exit 0**, and both print the same shape — a caller reads the
token, never a sentence. v1 printed two different English sentences from two different tools and made
every caller regex a number back out of prose.

**The create-once key.** The verb appends `split from #<parent>` to the child body itself, so the key
it later matches on is one it wrote rather than one a caller remembered — v1 called the
back-reference load-bearing and then never checked the body carried it, so a child filed without it
was permanently invisible to the guard and every re-run fired a fresh twin. Matching is on `(parent
back-reference AND normalized title)`. Title normalization is **Unicode-aware** (`\p{L}\p{N}`), not
ASCII: v1's ASCII key shreds a Turkish title into a handful of fragments, so two genuinely different
Turkish-titled siblings of one parent can collapse to the same key and the second is falsely reused —
a silent lost split, in the one direction v1's own module says it refuses.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `created` or `reused` was produced on stdout |
| `1` | usage error, unresolvable repo, a failed stdin read, or the verb failed to run |
| `2` | no implementation could be resolved |
| `3` | stdin was read and held nothing |
| `4` | the parent issue does not exist |
| `5` | the child body carries a machine-local path |
| `8` | the create failed — the outcome is UNKNOWN |
| `9` | the child was created but the read-back does not match |
| `127` | the verb never ran (unresolved binary) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage split: no body on stdin — pipe the child body in.` | 3 | refusal |
| `triage split: parent #<n> not found in <repo>.` | 4 | refusal |
| `triage split: the child body carries a machine-local path at line <k> (<class>) — rewrite it repo-relative.` | 5 | refusal |
| `triage split: create failed: <reason> — UNKNOWN whether a child landed; re-run this verb, which will reuse it if it did.` | 8 | refusal |
| `triage split: child #<n> created but its body read back changed — inspect before splitting further.` | 9 | refusal |

**Scope** — the union of two **read-after-write consistent** REST reads, both paginated, neither the
search index:

1. `GET /repos/{repo}/issues?state=open&labels=status:needs-triage` — the intake queue.
2. `GET /repos/{repo}/issues/{parent}/timeline` — the parent's cross-reference events, which surface
   every issue that references it, including children already triaged out of the queue.

**Neither half may be the search index, and that is the whole guarantee.** The index is eventually
consistent, so a child created seconds ago is invisible to it — which is precisely the five-second
twin window (#3462/#3463) this verb exists to close. `report dedup` may use the index because it is
advisory; a create-once guard may not.

**The scope deliberately extends past the queue** via read 2: v1 searched the needs-triage label
only, so a child that had already been triaged was invisible and re-splitting fired a twin. A read
failure in **either** half is exit `1` — never a silent `created`, which is the exact fail-open that
produced two identical children five seconds apart.

**Examples**

```
$ fabrika triage split 4312 --title "Editor loses focus after save" < child.md
created	4321	https://github.com/kamp-us/phoenix/issues/4321
```

```
$ fabrika triage split 4312 --title "Editor loses focus after save" < child.md
reused	4321	https://github.com/kamp-us/phoenix/issues/4321
$ echo $?
0
```

```
$ fabrika triage split 4312 --title "Editor loses focus after save" --json < child.md
{"outcome":"created","number":4321,"url":"https://github.com/kamp-us/phoenix/issues/4321","matchedOn":null,"crossLinked":true}
```

**Grounding**

- #3462 / #3463 — two byte-identical children five seconds apart; the create-once guard is that
  incident.
- v1 `split-child.sh:22-26` captures `split-guard`'s stdout and **never inspects its exit status**.
  The guard prints nothing on its negative, so an auth failure, a rate limit or a decode error
  produces the identical empty string as a proven "safe to create" — and the script falls through to
  the POST. That is why every outcome here is a token.
- v1 `split-match.ts:40-45` normalizes titles with `title.toLowerCase().split(/[^a-z0-9]+/)` —
  ASCII-only, against a corpus whose product titles are Turkish by repo law. This is the same defect
  `intake-dedup` fixed in #3255 and `split-guard` never received.
- v1 never cross-linked the parent; the `split into #A, #B` comment was left to the model. This verb
  posts it as part of the same operation, so the provenance trace is not optional.

---

## `triage enrich`

**Invocation**

```
fabrika triage enrich 4312 [--epic] [--repo <owner/name>] [--json]
```

The rewritten body arrives on **stdin only**, for the reason given under `triage split`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to enrich |
| `--epic` | boolean | no | `false` | wrap the original in place under a one-line header instead of writing a rewrite above it |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One tab-separated line: `enriched`, `<number>`, `<redactions>`, where
`<redactions>` is the count of machine-local paths masked in the preserved original. With `--json`,
an object with keys `outcome`, `number`, `redactions`, and `mode` (`rewrite` or `wrap`).

**The envelope, byte for byte.** The verb composes the new body itself, so the bytes are pinned here
rather than left to an implementer who would then verify them against a read-back of their own
invention. Default mode, where `<REWRITE>` is stdin verbatim and `<ORIGINAL>` is the redacted
original:

```
<REWRITE>

---

<details>
<summary>Original report (verbatim)</summary>

<ORIGINAL>

</details>
```

`--epic` mode takes **no stdin at all** and emits a fixed header instead of a rewrite:

```
**Epic — awaiting plan.** `plan-epic` appends its plan and dependency topology below.

<details>
<summary>Original brief (verbatim)</summary>

<ORIGINAL>

</details>
```

An epic's original is consumed verbatim by the downstream planning step, so a rewrite above it would
fork the brief. **In `--epic` mode exit `3` is unreachable and stdin is never read** — an earlier
draft required a body it then discarded.

**The re-enrich detector** matches the literal line `<summary>Original report (verbatim)</summary>`
or `<summary>Original brief (verbatim)</summary>`. On a match the verb replaces everything above the
opening `<details>` and preserves that block unchanged, so a second pass re-enriches rather than
nesting. Because the block is preserved rather than re-wrapped, no nesting can accumulate; "innermost"
is not a case that arises.

**Redaction is asymmetric and deliberate.** The **preserved original** is foreign content: any
machine-local path in it is masked to its class root, counted, and reported on stderr with its line
number. **Your rewrite** is authored now, so a machine-local path in it is refused on exit `5` — you
can fix what you just wrote. Refusing the original instead would strand the enrichment on somebody
else's leak, and preserving it unredacted re-commits that leak into a public issue.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `enriched` was produced on stdout |
| `1` | usage error, unresolvable repo, a failed stdin read, or the verb failed to run |
| `2` | no implementation could be resolved |
| `3` | stdin was read and held nothing — **default mode only; unreachable with `--epic`** |
| `4` | the issue does not exist |
| `5` | the **rewrite** carries a machine-local path |
| `8` | the `PATCH` failed — the outcome is UNKNOWN |
| `9` | the body was written but the read-back does not match |
| `127` | the verb never ran |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage enrich: no body on stdin — pipe the rewritten body in.` | 3 | refusal |
| `triage enrich: issue #<n> not found in <repo>.` | 4 | refusal |
| `triage enrich: your rewrite carries a machine-local path at line <k> (<class>) — rewrite it repo-relative. The preserved original is redacted automatically; this refusal is about the text you wrote.` | 5 | refusal |
| `triage enrich: redacted <k> machine-local path(s) from the preserved original (lines <l1>, <l2>).` | 0 | notice |
| `triage enrich: PATCH failed: <reason> — UNKNOWN whether the body changed; re-read #<n> before retrying.` | 8 | refusal |
| `triage enrich: body written but the read-back does not match — inspect #<n> before continuing.` | 9 | refusal |

**Scope** — one issue body. An issue whose body is already an enrich envelope is **re-enriched, not
nested**: the verb replaces the text above the existing `<details>` block and preserves the innermost
original, so a second pass cannot bury the provenance one level deeper each time. A body that cannot
be read is exit `4`; it never degrades to an empty original preserved as though it were the record.

**Examples**

```
$ fabrika triage enrich 4312 < enriched.md
enriched	4312	0
```

```
$ fabrika triage enrich 4290 < enriched.md
triage enrich: redacted 1 machine-local path(s) from the preserved original (lines 12).
enriched	4290	1
```

```
$ fabrika triage enrich 4318 --epic
enriched	4318	0
```

```
$ fabrika triage enrich 4312 --json < enriched.md
{"outcome":"enriched","number":4312,"redactions":0,"mode":"rewrite"}
```

**Grounding**

- #3019 / #2393 — a verbatim re-emit re-committed a machine-local path into a public issue. Fidelity
  loses to the leak invariant, and the redaction preserves evidential shape rather than stripping.
- v1 split this across `fetch-original.sh` and `patch-body.sh` and left **both** `original.md` and
  `original.redacted.md` on disk, with a code comment as the only thing steering the caller to the
  safe one. A leak invariant enforced by a filename preference is not enforced. Here one operation
  owns fetch, redact and write, and the raw original never exists as a separate artifact.
- v1 `patch-body.sh:24` reads the body through `BODY="$(cat …)"`, which strips every trailing
  newline, then passes it in argv — against a step that promises byte-for-byte preservation and can
  hit `ARG_MAX` on a large enrichment. Stdin and an in-process envelope remove both.
- v1's `PATCH` had no read-back, while the skill's own Step 0 names last-write-wins body clobbering
  as the reason its claim exists.

---

## `triage apply`

**Invocation**

```
fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47
fabrika triage apply 4312 --type chore --priority p2 --ready-for agent --lane axis:pipeline-hardening
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to stamp |
| `--type` | enum | yes | — | one of `bug`, `feature`, `chore`, `decision`, `investigation`, `epic` |
| `--priority` | enum | yes | — | one of `p0`, `p1`, `p2` |
| `--ready-for` | enum | yes | — | who picks it up: `human` or `agent` |
| `--home` | integer | one of | — | the **number** of an open milestone to home the issue in |
| `--lane` | enum | one of | — | a standing lane: `wayfinder:backlog` or `axis:pipeline-hardening` |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Exactly one of `--home` / `--lane` is required.** Supplying both, or neither, is a usage error. This
is the whole design: an un-homed `status:triaged` issue is **unrepresentable** rather than detected
afterwards, so the verb never needs to judge homing — a question already enforced by a CI guard
firing on the very label it applies. Requiring the input is a precondition; recomputing the verdict
would be a second answer to a gated question.

**Every classification value is a closed enum decoded at the boundary**, not a free string checked in
prose. `--priority 1` is refused before any write.

**Output** — machine channel. One tab-separated line: `triaged`, `<number>`, `<type>`, `<priority>`,
`<ready-for>`, `<home>` — where `<home>` is the milestone number or the lane label. With `--json`, an
object with those keys plus `removed` (the labels superseded) and `readBack` (the labels observed
after the write).

**The transition is one envelope, and the read-back proves the end state positively.** The verb
re-reads the issue's labels and asserts the positive shape required — exactly one `type:`, exactly
one `p*`, `status:triaged` present, exactly one `ready-for:`, `status:needs-triage` absent, and the
home present. It does **not** assert on the absence of an imagined failure, and it never reports the
requested classification as the landed one.

### The owned facets — what `apply` may remove

Closed input enums fix the *write*. They do not fix the *delete*, and #4285's actual mechanism was a
delete: `p2` was removed because the priority facet owned `/^p\d+$/` and `p2` was not in the keep
set. So the ownership rule is stated here rather than left for an implementer to invent:

| Facet | Owned pattern | Kept |
|---|---|---|
| type | `^type:` | `type:<--type>` |
| priority | `^p\d+$` | `<--priority>` |
| status | `^status:(needs-triage\|triaged\|needs-info)$` | `status:triaged` |
| audience | `^ready-for:` | `ready-for:<--ready-for>` |
| lane | `^(wayfinder:backlog\|axis:pipeline-hardening)$` | `<--lane>`, or none when `--home` was given |

**Every label matching an owned pattern and not in the keep set is removed; every label matching no
owned pattern is preserved untouched.** An `area:*`, a `fabrika`, a `wave:*` — none is this verb's
business, and a reconcile that removes what it does not own is a silent data loss.

**Because `--priority` is a closed enum, the priority facet's owned pattern can never be wider than
what `--priority` can emit** — which is precisely the invariant v1 broke. The generalised rule: for
every facet, the set of values the input can produce must be a subset of what the pattern owns. An
implementer adding a facet must re-check that containment.

### The label vocabulary is a precondition, not an assumption

Before any write, the verb asserts that every label it is about to apply exists in the repository —
the two `ready-for:` values, the six `type:` values, the three priorities, `status:triaged`, and,
with `--lane`, the lane label. A missing one **refuses on `7`** rather than writing.

This matters because GitHub's add-labels endpoint **creates an unknown label rather than rejecting
it**, which is the mechanism by which a bare `1` became a real label on #4282. A closed enum stops a
malformed *input*; only a vocabulary check stops a well-formed input from minting a label in a repo
that was never bootstrapped.

(At authoring time `ready-for:human`, `ready-for:agent` and `closed-by-triage` were verified present
in `kamp-us/phoenix` with audience-only descriptions. The check exists for the repo-agnostic case and
for drift, not because they are currently absent.)

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `triaged` was produced on stdout and the read-back proved the end state |
| `1` | usage error — including both or neither of `--home` / `--lane` — unresolvable repo, or the verb failed to run |
| `2` | no implementation could be resolved |
| `4` | the issue does not exist |
| `7` | a label this verb would apply does not exist in the repository — a fail-closed refusal |
| `8` | a label or milestone write failed — the outcome is UNKNOWN |
| `9` | the writes landed but the read-back does not show the required end state |
| `10` | an off-vocabulary value was supplied, or `--home` names a milestone that is not open |
| `127` | the verb never ran |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage apply: --priority must be one of p0, p1, p2 — got "<v>". Refusing to apply it as a label.` | 10 | refusal |
| `triage apply: --ready-for must be human or agent — got "<v>".` | 10 | refusal |
| `triage apply: --type must be one of bug, feature, chore, decision, investigation, epic — got "<v>".` | 10 | refusal |
| `triage apply: --lane must be wayfinder:backlog or axis:pipeline-hardening — got "<v>".` | 10 | refusal |
| `triage apply: milestone <n> is not an open milestone in <repo>.` | 10 | refusal |
| `triage apply: give exactly one of --home or --lane; an issue cannot be both homed and lane-exempt.` | 1 | usage error |
| `triage apply: label <name> does not exist in <repo> — refusing to write, because the API would create it (#4285).` | 7 | refusal |
| `triage apply: issue #<n> not found in <repo>.` | 4 | refusal |
| `triage apply: write failed after <k> of <m> changes: <reason> — #<n> may be partially labelled; re-run this verb, which is idempotent.` | 8 | refusal |
| `triage apply: read-back shows <observed> — expected exactly one type, one priority, status:triaged and one ready-for.` | 9 | refusal |

**`milestone <n> is not open` moved off `1` and onto `10`.** Deciding it requires a network read of
the repository's milestone set, so it is a verdict the verb *proved* — and rule 3 is explicit that a
proven verdict must never share a code with a failure to invoke, or `[ $? -ne 0 ]` reads "never ran"
as "ran and proved it". It sits with the other off-vocabulary refusals because a closed milestone is
an off-vocabulary home. `1` is left for the shape error alone.

**Order of operations.** The home is assigned **before** `status:triaged` is applied. The homing guard
fires on the label event, so stamping first opens a real window in which the issue is triaged and
un-homed and the guard reds on the happy path — and a guard that reds on correct work is one people
learn to ignore. The verb is idempotent: re-running it converges on the same end state.

**Scope** — one issue's labels and milestone. There is no zero-scope case: the issue either exists
(and is read back) or the verb exits `4`.

**Examples**

```
$ fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47
triaged	4312	bug	p2	agent	47
```

```
$ fabrika triage apply 4312 --type bug --priority 1 --ready-for agent --home 47
triage apply: --priority must be one of p0, p1, p2 — got "1". Refusing to apply it as a label.
$ echo $?
10
```

```
$ fabrika triage apply 4312 --type bug --priority p2 --ready-for agent
triage apply: give exactly one of --home or --lane; an issue cannot be both homed and lane-exempt.
$ echo $?
1
```

```
$ fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47 --json
{"outcome":"triaged","number":4312,"type":"bug","priority":"p2","readyFor":"agent","home":47,"removed":["status:needs-triage"],"readBack":["type:bug","p2","status:triaged","ready-for:agent"]}
```

**Grounding**

- **#4285** — v1's `apply-triage.sh` passes `--p` through as a free string, and the priority facet
  *owns* only `/^p\d+$/`. Running `--p 1` mints a literal label `1`, supersedes the real `p2` because
  `p2` is owned and not in the keep set, and leaves the issue reading fully triaged **with no
  priority at all** — while the verb prints a success line indistinguishable from a correct run. The
  closed enums and the positive read-back are that incident, from both ends.
- v1's tracker read-back does `const landed = landedStatus ?? status` — when the read finds no status
  label it **reports the requested one as landed**, and the type and priority labels are never
  verified at all. A read-back that falls back to the request is not a read-back.
- **#4780** — `status:triaged` states readiness, `ready-for:` states audience; a run that emits the
  first without the second is incomplete. Making it a required enum is what makes that structural.
- #4693 — an authoring brief left in the builder's candidate pool is the failure `ready-for:human`
  exists to prevent.
- ADR 0202 / 0208 — home or standing lane, never both, never neither. Enforced here as a required,
  mutually exclusive input rather than as a recomputed verdict.
- v1's `--status <stage>` flag is documented in its SKILL.md and **does not exist** in its script,
  which drops every argument past `$3` — so `needs-info`, one of three mandated outcomes, was
  unreachable. That outcome is `triage park` here, a first-class verb.

---

## `triage park`

**Invocation**

```
fabrika triage park 4312 [--repo <owner/name>] [--json]
```

The questions arrive on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to park |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One tab-separated line: `parked`, `<number>`, `<comment-url>`. With
`--json`, an object with keys `outcome`, `number`, `commentUrl`, and `removed` (the labels dropped).

**This is a separate verb rather than `apply --status needs-info`,** because a parked issue carries
no type, no priority, no audience and no home. Folding it into `apply` would make four required flags
conditionally required — the shape that let v1 emit a fully-triaged-looking issue with a facet
missing.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `parked` was produced on stdout |
| `1` | usage error, unresolvable repo, a failed stdin read, or the verb failed to run |
| `2` | no implementation could be resolved |
| `3` | stdin was read and held nothing — a park with no questions is not a park |
| `4` | the issue does not exist |
| `5` | the questions carry a machine-local path |
| `7` | `status:needs-info` does not exist in the repository |
| `8` | a write failed — the outcome is UNKNOWN |
| `9` | the writes landed but the read-back does not match |
| `127` | the verb never ran |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage park: no questions on stdin — a parked issue must say what would unblock it.` | 3 | refusal |
| `triage park: issue #<n> not found in <repo>.` | 4 | refusal |
| `triage park: the questions carry a machine-local path at line <k> (<class>) — rewrite it repo-relative.` | 5 | refusal |
| `triage park: label status:needs-info does not exist in <repo> — refusing to write, because the API would create it (#4285).` | 7 | refusal |
| `triage park: write failed: <reason> — #<n> may be partially labelled; re-run this verb, which is idempotent.` | 8 | refusal |
| `triage park: read-back shows <observed> — expected status:needs-info present and status:needs-triage absent.` | 9 | refusal |

**Scope** — one issue. The read-back asserts `status:needs-info` present and `status:needs-triage`
absent. Parking leaves the queue deliberately: a parked question must not resurface in every sweep,
and it re-enters when whoever answers swaps the labels back.

**Examples**

```
$ fabrika triage park 4290 < questions.md
parked	4290	https://github.com/kamp-us/phoenix/issues/4290#issuecomment-5154891644
```

```
$ fabrika triage park 4290 --json < questions.md
{"outcome":"parked","number":4290,"commentUrl":"https://github.com/kamp-us/phoenix/issues/4290#issuecomment-5154891644","removed":["status:needs-triage"]}
```

**Grounding**

- v1 could not produce this outcome at all — see the last Grounding entry under `triage apply`.
- The comment is posted before the label swap, so an issue never sits on `status:needs-info` with no
  statement of what would unblock it. The write order is the guard.

---

## `triage kill`

**Invocation**

```
fabrika triage kill 4312 --confirm [--duplicate-of <n>] [--repo <owner/name>] [--json]
```

The reason arrives on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to close not-planned |
| `--confirm` | boolean | yes | `false` | assert that the confirmation step ADR 0159 requires has been performed — salvage was attempted and this filing is genuinely unsalvageable or moves nothing forward |
| `--duplicate-of` | integer | no | absent | the surviving issue; this issue's content is folded into it before closing |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One tab-separated line: `killed`, `<number>`, `<foldedInto>` — where
`<foldedInto>` is the surviving issue number or `none`. With `--json`, an object with keys `outcome`,
`number`, `foldedInto` (number or `null`), `redactions` (count masked from the folded body), and
`provenance` (the value this verb read for itself).

**Two guards, and they are different guards.** ADR 0159 splits the population in two and puts a
distinct protection on each half; a spec that implements one and drops the other has narrowed an
accepted decision.

1. **Footer absent ⇒ human-owned ⇒ PROTECTED.** The verb runs the `triage provenance` predicate
   itself rather than trusting the caller to have run it; a `human` answer, including the fail-closed
   default on an unreadable body, refuses on exit `11`.
2. **Footer present ⇒ eligible *after confirmation*, and "the confirmation step IS the guard."**
   A human-invoked `/report` also emits the footer, so footer presence alone is **not** licence to
   close — ADR 0159 reserves a confirmation-free close-sweep as an explicitly re-opened question.
   `--confirm` is that step made structural: without it the verb refuses on exit `12`, so an
   autonomous sweep cannot close on footer presence alone, and the flag is a greppable, auditable act
   rather than a thing the model was supposed to remember.

**The duplicate fold is redacted.** With `--duplicate-of`, this issue's body is posted as a comment on
the surviving issue **through the same redaction `triage enrich` applies**, before this issue is
closed. v1 redacted the enrich path and left this one raw — the same body, copied into a new public
location, with the leak matcher literally named for comments.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | `killed` was produced on stdout |
| `1` | usage error, unresolvable repo, a failed stdin read, or the verb failed to run |
| `2` | no implementation could be resolved |
| `3` | stdin was read and held nothing — an unauditable kill |
| `4` | the issue does not exist, is already closed, or `--duplicate-of` does not exist or is closed |
| `5` | the reason text carries a machine-local path |
| `7` | `closed-by-triage` does not exist in the repository |
| `8` | a write failed — the outcome is UNKNOWN, and the issue may be closed unexplained |
| `9` | the writes landed but the read-back does not show a not-planned close |
| `11` | refused: the issue is human-filed |
| `12` | refused: agent-filed and close-eligible, but `--confirm` was absent (ADR 0159) |
| `127` | the verb never ran |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage kill: no reason on stdin — refusing an unauditable kill.` | 3 | refusal |
| `triage kill: issue #<n> not found in <repo>.` | 4 | refusal |
| `triage kill: issue #<n> is already closed.` | 4 | refusal |
| `triage kill: --duplicate-of #<m> is closed — refusing to fold this issue's content into a closed issue where nobody will read it.` | 4 | refusal |
| `triage kill: the reason carries a machine-local path at line <k> (<class>) — rewrite it repo-relative.` | 5 | refusal |
| `triage kill: label closed-by-triage does not exist in <repo> — refusing a kill that would be invisible to the audit.` | 7 | refusal |
| `triage kill: #<n> is human-filed — refusing to close it. Park it with questions instead.` | 11 | refusal |
| `triage kill: #<n> is agent-filed and close-eligible, but ADR 0159 makes the confirmation the guard — pass --confirm once salvage has genuinely been attempted.` | 12 | refusal |
| `triage kill: the fold comment on #<m> failed: <reason> — #<n> is NOT closed; nothing was lost. Re-run.` | 8 | refusal |
| `triage kill: closed, but the read-back shows state_reason=<observed>, not not_planned — #<n> reads as done rather than killed.` | 9 | refusal |
| `triage kill: redacted <k> machine-local path(s) from the folded duplicate body.` | 0 | notice |

**Write order is the auditability guarantee.** Fold the duplicate content, post the reason comment,
apply `closed-by-triage`, then close with `state_reason=not_planned` — and **each step gates the
next**. v1 ran three unguarded sequential writes under `set -uo pipefail` with no `-e`, so a failed
reason comment did not stop the close: the issue landed closed, unexplained, and invisible to the
kill audit. Here a failure before the close leaves the issue **open**, which is the recoverable
direction. The read-back asserts `state` is `closed` **and** `state_reason` is `not_planned`, because
a plain `closed` reads as "done", not "killed".

**Scope** — one issue, plus the surviving issue when `--duplicate-of` is given.

**Examples**

```
$ fabrika triage kill 4312 --confirm --duplicate-of 4290 < reason.md
killed	4312	4290
```

```
$ fabrika triage kill 4290 --confirm < reason.md
triage kill: #4290 is human-filed — refusing to close it. Park it with questions instead.
$ echo $?
11
```

```
$ fabrika triage kill 4312 < reason.md
triage kill: #4312 is agent-filed and close-eligible, but ADR 0159 makes the confirmation the guard — pass --confirm once salvage has genuinely been attempted.
$ echo $?
12
```

```
$ fabrika triage kill 4312 --confirm --json < reason.md
{"outcome":"killed","number":4312,"foldedInto":null,"redactions":0,"provenance":"agent"}
```

**Grounding**

- v1 `close-not-planned.sh:18-20` — three unguarded writes; a failed comment still closes the issue.
  It validates its *input* (an empty reason is refused) and never its *outcome*.
- v1 `fetch-duplicate-body.sh:25` → `post-duplicate-comment.sh:23` copies a body verbatim into a
  public comment with no leak pass, while `fetch-original.sh:30` redacts on the other path. One
  emitter, always redacting, removes the asymmetry.
- ADR 0159 / v1 Step 5 — human-filed issues are never auto-closed. v1 stated it in 48 lines of prose
  and computed it nowhere.
- v1 `audit-kills.sh` — the compensating control for the whole kill path — reads one unpaginated
  page, so it goes blind past 30 kills with no truncation signal. This spec does not re-mint that
  verb; the audit belongs to a board surface, and the fail-closed write order above is what makes a
  kill auditable at the moment it happens.

---

## `report dedup` — the `--exclude` extension

**Invocation**

```
fabrika report dedup --query "sozluk definition editor loses focus" --exclude 4312
```

**Input**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--exclude` | integer | no | absent (no issue is filtered) | an issue number to omit from both sources — the issue being deduped, so it never flags itself |

Everything else — the tokenizer, the two sources, the three outcome tokens — is unchanged from the
implemented verb at `packages/fabrika-cli/src/report/dedup.ts` and its verb wrapper
`dedup-verb.ts`. **This change adds no exit code, no error, and no output shape**: `candidates`,
`none` and `indeterminate` all still exit 0, and the existing `1` / `3` / `4` / `7` are untouched.

**Behaviour.** The excluded number is filtered from both the queue half and the search half **after**
retrieval and **before** scoring and the cap, so excluding an issue never changes the rank order of
the rest and never lets a truncated row take the excluded issue's place. `--exclude` naming an issue
that does not exist is not an error: the filter simply matches nothing, because the caller's intent —
"not this one" — is satisfied either way.

**Scope note.** Excluding the only candidate yields `none`, which remains a **proven** negative: both
sources were read and nothing else matched. It is not `indeterminate`, which is reserved for a query
that carried too few distinctive tokens to compare at all.

**Examples**

```
$ fabrika report dedup --query "definition editor loses focus after an entry is saved" --exclude 4312
none
```

```
$ fabrika report dedup --query "definition editor loses focus after an entry is saved"
candidates
4312	queue	3	Sozluk definition editor loses focus after an entry is saved
```

The pair is the point: the same query returns the issue itself without `--exclude`, and a proven
`none` with it.

**Grounding**

- The `/report` contract deferred this flag to this seam by name. This is the first caller.
- v1's `intake-dedup` carries `--exclude` for the same reason; its scars (empty stdout as the
  negative, the discarded `source`/`score`, exit 0 on a zero-token non-check) were already designed
  out by the `/report` contract's outcome tokens, so this extension inherits the fixed verb.
