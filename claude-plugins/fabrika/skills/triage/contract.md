# `/triage` — derived CLI contract

**Skill:** [`triage`](SKILL.md) · **Authoring brief:** [#4706](https://github.com/kamp-us/phoenix/issues/4706) · **Date:** 2026-08-02

These verbs live in `packages/fabrika-cli/`, binary `fabrika`, grouped under a `triage` subcommand,
beside the `adr` and `report` groups already implemented there. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs them; where this spec and
that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every verb below
is implemented from scratch here. v1's tools and its 18 `scripts/` were read for their semantics and
their scars — each Grounding section names what the v1 counterpart gets wrong and what this spec does
instead — but no clause defers to one, and none is invoked. Two edges are sanctioned and are not
calls: a CI gate stays the authority on its own question, so this spec expects `pitch-guard`'s answer
rather than recomputing it; and where both programs must agree on the same bytes, fabrika owns the
wire format and the other side conforms by pinning fabrika's golden fixture in a test (ADR
[0251](../../../../.decisions/0251-shared-formats-are-pinned-not-reimplemented.md)).

**Substrate.** These verbs are Effect CLI verbs on the `@effect/platform-node` seam already used by
the sibling groups; GitHub access per
[skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql).
Named here because `cli-interface-convention.md` states no substrate and a spec that leaves it open
makes the implementer guess ([#4734](https://github.com/kamp-us/phoenix/issues/4734)).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `triage queue` | the claimable `status:needs-triage` queue, with the count it scanned | paginating a label query and separating a proven-empty queue from a failed read is mechanical; which issue to take is judgment |
| `triage claim` | take one lane's claim on one issue, proven by read-back | a marker write plus an earliest-claim tiebreak is a protocol, not a decision |
| `triage scratch` | the per-lane directory this lane's working files go under | keying a namespace on the claim nonce is mechanical; what the file holds is judgment |
| `triage provenance` | was this issue reported by an agent or hand-typed by a human | a structural marker test over a fetched body, plus a membership test over the configured operator set — an empty body fails closed to `human`, an unreadable one refuses rather than guessing; what to *do* about a human filing stays in the skill |
| `triage homes` | the assignable homes — open milestones joined to their ROADMAP rows, plus the standing lanes this repo declares AND carries the labels for, with every `active` campaign's milestone marked `running` | the join, the open-milestone filter and reading the campaigns table are mechanical; picking which home fits, and whether an exception applies, is judgment |
| `triage split` | create one split child, once, keyed on the parent back-reference | idempotency keyed on a durable reference is mechanical; deciding a report *is* a bundle is judgment |
| `triage enrich` | replace the body with your rewrite — or, for an epic, your pitch — over a preserved, leak-redacted original | envelope assembly, redaction and read-back are mechanical; what the rewrite says is judgment |
| `triage apply` | apply the whole triaged transition — type, priority, audience, home — and read it back | closed-vocabulary validation and an atomic label envelope are mechanical; the classification is judgment |
| `triage park` | park a human-filed issue on `status:needs-info` with questions | the label swap and comment are mechanical; the questions are judgment |
| `triage kill` | close an agent-filed issue not-planned — or any issue being folded into a survivor with `--duplicate-of` — auditably, preserving a duplicate's content | the three-write envelope, the redacted fold and the human-filed refusal (which the fold lifts, #6070) are mechanical; the verdict is judgment |

One existing verb gains one flag:

| Change | Why |
|---|---|
| `report dedup` gains `--exclude <number>` | The [`/report` contract](../report/contract.md) deliberately omitted it — *"it exists for the triage seam, where the issue being deduped already exists and must not flag itself; this skill's dedup runs before its issue exists, so the flag would have zero callers."* This is that seam, and this is its first caller. Minting a second dedup verb here would duplicate a 200-line tokenizer to add one filter. |

### Considered and deliberately not derived

Each is a real proposal someone could make again, so it is recorded rather than left to be
re-litigated.

**These rejections are in the wrong place, and that is tracked debt rather than a choice.**
Conventions §7 puts them in a plugin-root `.out-of-scope/`, which does not exist for any fabrika
skill; bootstrapping it is corpus-wide work, this spec does not create the directory, and until it
exists every fabrika skill's rejections live inline like these.

- **A `triage homing-check` verb.** `homing-guard` is CI-enforced on `issues: [labeled, unlabeled,
  milestoned, demilestoned]` (`.github/workflows/homing-guard.yml`) — it fires on the exact label
  write `triage apply` makes. A fabrika copy could only agree redundantly or disagree with the
  enforced verdict. `apply` instead takes the home as a **required input**, so an un-homed
  `status:triaged` is unrepresentable rather than detected after the fact. That is a precondition,
  not a second verdict.
- **A `triage pitch-check` verb.** Same shape: `.github/workflows/pitch-guard.yml` fires on
  `issues: [labeled]` filtered to `status:triaged`. Worse, v1's wrapper *reds on its own expected
  case* — an unapproved pitch is the normal state of freshly-triaged work and resolves to
  `pass: false` → exit 1, so the happy path always looks like a failure. The skill drafts the pitch —
  into the body `triage enrich` writes — and lets the seam gate answer.
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

### The name collision with v1's `triage` — live while v1 stood, retired with it

**A skill named `triage` existed** at `claude-plugins/kampus-pipeline/skills/triage/` until the v1
plugin's retirement (ADR 0303, #5937); it was model-invoked, and its six triggers were
near-identical to this one's. The `/report` contract recorded the analogous collision as "dormant
only by configuration — `.claude/settings.json` has `"kampus-pipeline@kampus": false`". **That
reasoning did not hold.** `.claude/skills` was a symlink to `claude-plugins/kampus-pipeline/skills`,
so v1's skills loaded as *project-level* skills and the plugin toggle did not stop them: a live
session's roster carried both `adr` and `fabrika:adr`, and both `report` and `fabrika:report`.
Settled by [ADR 0255](../../../../.decisions/0255-skill-namespaces-keep-v1-and-fabrika-apart.md)
(filed as #4829); the adjacent routing-pin half is #4761.

What the ADR measured sharpens this: the two never shared a name — the loader namespaces plugin
skills, so the bare `triage` was always v1's. What overlapped was the **description**, and this
pair's overlap was the corpus's worst (same plugin-relative role, nearly identical triggers). So
the stated mitigation was the right one, and it stays load-bearing as description discipline even
with the collision gone. Two things follow, and neither is optional:

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

**Every verb in this group allocates from one internal table**, so a code means one thing across *this group*.
That is a property of this group and not of `fabrika`, and the difference matters to anyone driving
more than one group: **repo-wide the same number does not mean the same thing.** `wire`'s `3` is
*the format's block is provably not in the artifact*, where `report`'s and this group's is *stdin was
read and held nothing*.

Where this group's codes overlap **`report`'s writing verbs** (`3`, `5`, `6`, `7`, `8`, `9`,
`10`, `11`) they match them **deliberately**, code for code, so a caller driving `report` and `triage`
in one sweep reads one meaning. This spec calls `report dedup` (the `--exclude` extension below), and
that verb reads from the same `report` table: `7` when `--label` is absent, `27`/`28` when the queue
or the search index could not be read
([#5296](https://github.com/kamp-us/phoenix/issues/5296)).

| Code | Meaning | queue | claim | prov | homes | split | enrich | apply | park | kill | scratch |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, unresolvable repo, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | — | — | — | ✓ | ✓ | — | ✓ | ✓ | — |
| `4` | *(deliberate gap — see below)* | — | — | — | — | — | — | — | — | — | — |
| `5` | the **authored** text carries a machine-local path | — | — | — | — | ✓ | ✓ | — | ✓ | ✓ | — |
| `6` | the **authored** text is a bare `@` path reference — **not** redactable | — | — | — | — | ✓ | ✓ | — | ✓ | ✓ | — |
| `7` | zero scope: a read that succeeded over nothing, an absent label vocabulary, or a target issue **proven absent (404)** or closed — a fail-closed refusal | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `8` | the write itself failed — the outcome is **UNKNOWN** | — | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `9` | the write landed but the read-back does not match | — | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `10` | the supplied value is not permitted here — off the closed vocabulary, a non-open milestone, or a slug that is not a kebab-case leaf | — | — | — | — | — | — | ✓ | — | — | ✓ |
| `11` | a **precondition read failed** — nothing was written and the outcome is UNKNOWN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `12` | refused: the issue is human-filed and this is not a `--duplicate-of` fold | — | — | — | — | — | — | — | — | ✓ | — |
| `13` | refused: close-eligible, but the kill is unconfirmed (ADR 0159) | — | — | — | — | — | — | — | — | ✓ | — |
| `15` | refused: the body this verb composed carries an acceptance-criteria block its registered wire reader classifies `Malformed` (ADR 0288) | — | — | — | — | — | ✓ | — | — | — | — |
| `16` | refused: `--ready-for agent` over a live body whose acceptance-criteria block the wire reader does not answer `Found` on — every type but `epic` | — | — | — | — | — | — | ✓ | — | — | — |
| `17` | refused: a live claim marker on the target names a claimant other than the asking lane — another session, or another lane of this one | — | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `18` | refused: no value of `.fabrika.jsonc` may be used — a key's load-time check refused it, it could not be read, or it did not decode | — | — | — | — | — | — | ✓ | ✓ | — | — |
| `19` | refused: the asking lane holds no live claim on the target | — | — | — | — | — | — | — | — | — | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**This matrix owns what a code *means*; the per-verb tables own what *triggers* it.** Every verb in
this group can return `0`, `1`, `126` and `127` with the meanings above, and each of the four is stated
**here and nowhere else** — the per-verb "Exit status" tables below enumerate only that verb's own
proven outcomes, `3` and up, phrased as that verb's trigger rather than as a restatement of the
meaning. The reason is a defect this spec already shipped once: an earlier revision restated every
code in all nine verb tables, and a `127` row added to the matrix reached only five of them. One fact
in ten places is nine chances to drift, so the fact has one place.

**`14` is allocated in code and missing from this matrix, and that is a known gap this spec does not
close.** `packages/fabrika-cli/src/triage/codes.ts` seats `UNREPAIRABLE = 14` for `triage
repair-criteria`, a tenth verb this document does not yet specify at all — it has no column above
and no section below. Writing its row here would be guessing at a spec nobody has written, so `15`
takes the next free seat instead of compacting into `14`, and the gap is disclosed rather than
silently filled ([#5855](https://github.com/kamp-us/phoenix/issues/5855)).

**`4` is a deliberate gap, not a free slot.** It held *"the target issue does not exist, or is not
readable"* — one code for a proven fact and an unknown at once, which is the exact fusion `7` and
`11` exist to prevent. Those two took the halves: **proven absent (404) → `7`, unreadable → `11`**.
`4` is left unallocated rather than compacted away, both because a gap is cheaper than a collision
and because it keeps the alignment with `report file`, where `4` is a body-section failure no verb
here performs.

**`7` is the fail-closed refusal over scope that is provably not there**: a read that succeeded and
returned nothing, a required label vocabulary that is absent, or a target issue that is **proven
absent or closed**. *Proven* is the operative word — a 404 is a fact about the repository, while an
unreachable GitHub is not a fact about anything.

That reading was checked against the shipped binary rather than against a document.
`fabrika report dedup --help` at `v0.1.0` states it "Exits … 7 (`--label` does not exist, so the queue
half would scan nothing)" — a zero-scope refusal. (The checked-in
[`/report` contract](../report/contract.md) lists only `0/1/3/4` for `dedup` and is therefore behind
its own implementation on this point; the binary is the authority, and the drift is noted in this
skill's handoff rather than silently copied.)

**`11` is `report`'s shipped `PRECONDITION_UNKNOWN`**, and this spec matches it rather than inventing
a meaning: `packages/fabrika-cli/src/report/codes.ts` defines `PRECONDITION_UNKNOWN = 11` as *"a
precondition read failed, so nothing was written and no outcome is proven … It is not `8` — nothing
was attempted — and not `1`, which would fuse an unreachable GitHub with a bad flag."* `report file`
seats its label-set read there and `report note` its `getIssue` `Unknown`. Every verb here that reads
before it answers seats an unreadable read on it too. An earlier revision of this spec used `11` for
the human-filed refusal, colliding with the shipped meaning; those refusals moved to `12` and `13`.

**`8` and `9` are deliberately not `1`.** A create or PATCH that times out may or may not have
landed; seating that on `1` makes "GitHub refused the write" indistinguishable from "the binary is
broken", which is the verdict-versus-invocation collision the reserved range exists to prevent. Each
`8` message carries its recovery instruction, because a blind retry is how one split becomes two
children.

**`10` is the superset that keeps `report`'s reading true.** There it is `CLASSIFIED` — a title or
`--label` carrying a type or priority. Here it is *the supplied classification value is not permitted
in this position*: off the closed enum, or a `--home` naming a milestone that is not open. A closed
milestone is an off-vocabulary home, so it belongs with the enum refusals rather than with the shape
errors.

**`5` applies only to text the caller just wrote, never to content being preserved.** Authored text
is refusable because the author can fix it; foreign content being copied forward is **redacted
automatically**, because refusing it would strand the operation on somebody else's mistake. This
asymmetry is the whole of the leak design and it is stated once here.

**`5` and `6` are separate because their fixes are opposite**, exactly as in `report`. The caller loop
on a path refusal is *redact and re-send*; on a body that **is** a path, masking is a no-op and that
loop never terminates.

### Read-backs compare normalized text, not bytes

Every write verb re-reads its target and compares. The comparison is **normalized**, and the
normalization is not a description to re-derive — it is a shipped function:
**import `normalizeForReadback` from `packages/fabrika-cli/src/report/compose.ts`.** Naming the module
rather than the prose is deliberate, for the same reason the leak predicate is named below.

It does **three** things, in order, and all three are load-bearing:

1. line endings `\r\n` → `\n`;
2. per-line trailing `[ \t]+` stripped;
3. **every trailing newline stripped** (`.replace(/\n+$/, "")`).

Step 3 is the one a re-derivation drops, and dropping it fires exit `9` on clean runs:
`composeBody` in the same module emits a trailing `\n`, so the composed text and the body GitHub
returns differ by a newline that means nothing. GitHub is not documented to round-trip a body
byte-for-byte either, which is why this comparison is normalized at all; the implementer should
confirm the round-trip against the live API before tightening it.

### Machine-local path detection

`triage enrich`, `triage kill`, `triage split` and `triage park` share the leak predicate **already
implemented** at `packages/fabrika-cli/src/report/leaks.ts` — three structural shapes (home-relative
`~/`, absolute home root `/Users/<account>` and `/home/<account>`, and the temp roots `/tmp`,
`/private/tmp`, `/private/var`, `/var/folders`), no name list, each redacting to its class root, and
specified in full in the [`/report` contract](../report/contract.md). The same module's separate
bare-`@`-reference case — an authored body whose first non-whitespace run is an `@`-prefixed path —
is exit `6` on all four verbs, unredactable, because the fix is to send the body.

**Import that module; do not re-derive the predicate.** Naming the module rather than the document is
deliberate — a prose pointer is a deferral, and a second leak predicate that drifts from the first is
worse than either alone. The same applies to the dedup core at
`packages/fabrika-cli/src/report/dedup.ts`, which the `--exclude` extension modifies rather than
copies, and to `renderFooter` in `packages/fabrika-cli/src/report/compose.ts`, which `triage split`
imports to stamp its child.

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
| `7` | `--label` does not exist in the repository — the queue would scan nothing |
| `11` | the queue read failed — the outcome is UNKNOWN, never `empty` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage queue: cannot read the <label> queue in <repo>: <reason> — the outcome is UNKNOWN, never "empty".` | 11 | refusal |
| `triage queue: label <label> does not exist in <repo> — refusing to report an empty queue over zero scope (ADR 0092).` | 7 | refusal |
| `triage queue: --limit must be 1 or greater.` | 1 | usage error |

**Scope** — every open issue in `--repo` carrying `--label`, read with pagination. **`empty` and a
failed read are different answers and never share a channel or a code.** The distinction is
load-bearing because the skill uses this verb as a sweep's termination test: a renamed label or a
scope-limited token returns HTTP 200 with `[]`, and v1 terminated the sweep on it and reported the
queue drained. The label's existence is checked against the repository's label set, so a typo reds on
`7` rather than answering `empty`. The scope line on stderr names the scanned count on every run.

The read is this verb's whole answer rather than a step toward a write, so its failure is `11` for
the same reason it is `11` everywhere else here: `1` would fuse an unreachable GitHub with a bad
flag, and this verb has a bad flag (`--limit`) sitting on `1` already.

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
- v1 `list-queue.sh` prints `(.user.login)` on every row — the filer. A bare login on a queue row is
  not a provenance verdict: it takes the footer *and* the configured operator set to reach one, which
  is `triage provenance`'s job. This verb omits the column and defers to that verb.
- v1 paginated neither this read nor `list-open-milestones.sh`; the latter silently capped home
  candidates at GitHub's default 30 while "nothing fits" routed to a standing lane or a kill.

---

## `triage claim`

**Invocation**

```
fabrika triage claim 4312 [--token <claim-token>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue number to claim |
| `--token` | string | no | mint a new lane | the token a previous claim handed THIS lane — re-enter it rather than minting a second |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `won\t<claim-token>`, or `lost\t<holder-session-id>`. **Both
are proven answers and both exit 0**, with the discriminator in the state word — the same
three-outcome shape `report dedup` already uses. A losing claim is something this verb *determined*,
not something that prevented it from answering, so seating it on a non-zero code would contradict the
shared rule that a non-zero exit is UNKNOWN and would make "another sweep holds it"
indistinguishable from "the verb is broken".

With `--json`, an object with keys `outcome` (`won` / `lost`), `session` (this session's id), `token`
(this lane's claim token), `holder` (the winning session id, `null` on `won`), `holderLane` (the
winning lane's nonce, `null` on `won` or when the winner is a pre-#6132 marker), `markers` (count of
live markers considered), and `expired` (count discarded as older than the TTL).

**A claim names a lane, not a session.** One fan-out runs several triagers under one
`$CLAUDE_CODE_SESSION_ID`, so a marker stamped with the session alone cannot tell two of them apart:
on 2026-08-18 two siblings each read the other's marker back as their own, both answered `won`, and
both wrote the issue ([#6132](https://github.com/kamp-us/phoenix/issues/6132)). The lane is a token,
`triage:<session-id>:<uuid>` — the same shape and the same nonce rule the `build` namespace resolves
ownership by ([#6037](https://github.com/kamp-us/phoenix/issues/6037)), in its own namespace so the
two never collide. A run with no `--token` mints one and races under its nonce; a run that passes the
token it was handed re-enters the lane it already holds.

**The marker literal.** A claim is one issue comment whose body is exactly:

```
<!-- fabrika-triage-claim session=<session-id> lane=<nonce> -->
```

One line, no surrounding prose, so a marker is matched by an exact prefix rather than by parsing
human text. `<session-id>` is the verbatim value of `$CLAUDE_CODE_SESSION_ID`; `<nonce>` is the first
8 hex of the claim token's UUID. Any comment not matching that prefix is not a marker and is ignored.
A marker carrying no `lane=` field is a pre-#6132 claim: it is counted, it ages out on the same TTL,
and every lane reads it as **another** claimant's — never as its own.

**The ordering key is the comment's `created_at` as returned by GitHub**, never a timestamp embedded
in the marker text: the body is caller-supplied and a caller could backdate itself into winning every
race. "Older than the TTL" is measured against that same `created_at`. Earliest surviving marker
wins.

**The TTL is a fixed 60 minutes and there is no flag for it.** A marker carries no TTL of its own, so
the session that ages it out is never the session that placed it: `--ttl-minutes 240` posted a claim
its placer thought bound for four hours and the five mutating verbs stopped honouring at one — the
fail-open direction the guard exists to close. One constant is the only reading, for placer and
reader alike; widening the window means changing that constant.

**The claim is a session-stamped comment, never the assignee.** Every agent authenticates as the same
login, so the assignee field cannot discriminate two concurrent sweeps — it is a shared availability
slot (#4780, and v1's own `claim-assign.ts` says as much: *"every agent authenticates as the same
login, so the assignee is one shared slot"*). The session id comes from `$CLAUDE_CODE_SESSION_ID`; with it
unset the verb exits `1` rather than posting an unattributable marker.

**Resolution.** Post this session's marker, re-read all markers on the issue, discard any older than
the TTL, and the **earliest surviving marker wins**. `won` requires a positive proof that the
winner is this session; every unresolvable state answers `lost`, never `won`.

**The claim binds, and every mutating verb is what makes it bind.** `split`, `enrich`, `apply`,
`park` and `kill` each re-read the markers on their target immediately before their first write, and
refuse on `17` when a live one names another claimant — the check reuses this verb's own reader and
resolver, so there is one marker grammar. Those five decide foreignness on the **session+lane pair**,
the same identity `claim` resolves on: each takes the optional `--token` this verb handed the lane,
and a same-session marker under a different nonce is somebody else's
([#6303](https://github.com/kamp-us/phoenix/issues/6303)). A call that passes no `--token` cannot say
which lane it is, so it is priced fail-closed on exactly that: it passes while its session's live
markers all name one lane, and refuses on `17` once two lanes of its session hold live markers.
Holding **no** marker still passes: an unclaimed issue is
the ordinary first-triage case, and demanding one would refuse every existing caller. The same
re-read refuses a closed target on `7`, and a comment read that fails is `11`. A `--token` that will
not parse as `triage:<session-id>:<uuid>`, or that carries a session other than the one running, is a
usage error on `1` on all five — the same two lines `claim` itself prints, verbatim, since it is the
same reader; a lane names itself, never another. Before, the protocol
was advisory at exactly the point it needed to bite: on 2026-08-15 a session that had read `lost`
ran `enrich` anyway and replaced the winner's authored body
([#5644](https://github.com/kamp-us/phoenix/issues/5644), on
[#5642](https://github.com/kamp-us/phoenix/issues/5642)). There is no override flag — nothing in that
incident needed one, and a flag added before a real need is a flag agents learn to pass reflexively.

**The marker has a lifecycle, and both ends of it are specified.** This is the one verb here that
*is* a race protocol, so leaving either end to an implementer's judgment would let the protocol
create the race it exists to resolve. Every other write verb states its idempotency; so does this one.

- **A losing claim deletes the marker it just posted**, before printing `lost` —
  `DELETE /repos/{repo}/issues/comments/{id}` on its own comment id, and only that id. Litter left
  behind survives the full TTL and its `created_at` is *older* than every marker posted after it, so
  a session that already conceded can beat a rightful winner on a later run. The delete is what keeps
  "earliest surviving marker" a statement about live claimants.
- **A failed deletion is `9`, not `0`.** The write landed, the intended end state (no marker of mine)
  is not what the issue carries, and the caller has to know a stale marker of theirs is sitting on
  the issue. Answering `lost` at exit 0 would hide it until it won a race nobody was running.
- **A lane that already holds a live marker on the issue re-reads and re-resolves rather than
  posting a second.** A second marker under the same nonce cannot win anything the first did not —
  it is strictly later — so posting it only adds litter to clean up. Re-running this verb under the
  `--token` it was handed is therefore idempotent: the same marker, re-resolved. Re-running it
  *without* the token is not a re-entry at all — it is a new lane, and it races like one.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the issue is proven absent (404), or is closed — nothing to claim |
| `8` | the marker `POST` failed — UNKNOWN whether a marker landed |
| `9` | the marker was posted but the read-back does not find it, or a conceded marker could not be deleted |
| `11` | the issue or its comment list could not be read — no claim was resolved |

`6` is unreachable here: this verb reads no stdin, so it has no authored text to be a bare `@`
reference. It was allocated to `lost` in an earlier draft, which put an answer on stdout at a
non-zero exit — that is why `lost` exits 0, and why the code now belongs to the shared leak pair
rather than to this verb.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage claim: CLAUDE_CODE_SESSION_ID is unset — refusing to post an unattributable claim.` | 1 | refusal |
| `triage claim: --token "<t>" is not a claim token (triage:<session-id>:<uuid>) — which lane is asking is not stated.` | 1 | refusal |
| `triage claim: --token "<t>" carries session <s>, but this run is session <mine> — a lane names itself, never another.` | 1 | refusal |
| `triage claim: issue #<n> not found in <repo>.` | 7 | refusal |
| `triage claim: issue #<n> is closed — nothing to triage.` | 7 | refusal |
| `triage claim: #<n> is held by session <holder> [on lane <nonce>] since <created_at> — backing off.` | 0 | notice |
| `triage claim: cannot read #<n> or its comments in <repo>: <reason> — no claim was resolved; never "won".` | 11 | refusal |
| `triage claim: marker POST failed: <reason> — UNKNOWN whether it landed; re-run before mutating #<n>.` | 8 | refusal |
| `triage claim: marker posted but absent on read-back — treating the claim as lost.` | 9 | refusal |
| `triage claim: lost #<n>, but this session's marker <id> could not be deleted: <reason> — a stale claim is live on the issue until <expiry>; delete it by hand.` | 9 | refusal |

**Scope** — the issue's comments, paginated, filtered to the marker prefix. A comment read that fails
is exit `11`; it never degrades to `won`. Session ids are printed **in full** on both channels — there
is no abbreviation rule — because a truncated id cannot be compared against `$CLAUDE_CODE_SESSION_ID`
by a caller.

**Examples**

```
$ fabrika triage claim 4312
won	triage:b2e1-4c07-4a99-9f30-55da1e6b7c02:5f1c9a20-4b11-4e05-8d77-c2a4f9be1234
```

```
$ fabrika triage claim 4312
triage claim: #4312 is held by session 7f3c-9a20-4b11-8e05-1d77c2a4f9be on lane 9a204b11 since 2026-08-02T09:14:02Z — backing off.
lost	7f3c-9a20-4b11-8e05-1d77c2a4f9be
$ echo $?
0
```

A sibling lane of your OWN session wins the same way, and the notice names the lane so the answer
does not read as this lane losing to itself:

```
$ fabrika triage claim 4312
triage claim: #4312 is held by session b2e1-4c07-4a99-9f30-55da1e6b7c02 on lane 7c3d0e91 since 2026-08-18T21:02:11Z — backing off.
lost	b2e1-4c07-4a99-9f30-55da1e6b7c02
```

```
$ fabrika triage claim 4312 --json
{"outcome":"won","session":"b2e1-4c07-4a99-9f30-55da1e6b7c02","token":"triage:b2e1-4c07-4a99-9f30-55da1e6b7c02:5f1c9a20-4b11-4e05-8d77-c2a4f9be1234","holder":null,"holderLane":null,"markers":1,"expired":0}
```

**Grounding**

- v1 `claim-issue.sh:29` reads `ME=$(gh api user --jq '.login')` unguarded. With a broken token `ME`
  is empty, every comparison against it is `"" = ""` → true, and the script prints `claim: won` and
  **exits 0** — a fail-open claim on a token that cannot write. `won` here requires positive proof.
- v1 `claim-issue.sh:35-36` cannot distinguish "unassigned" from "the read failed": both are the
  empty string, and the empty string means free-to-claim.
- v1 `claim-issue.sh:51` `DELETE`s other accounts' assignments, so a human self-assigning inside the
  race window loses it to a string comparison. This verb writes only its own marker and deletes only
  its own marker — never another session's, and never on a win.
- #4780 — audience moved to `ready-for:`, so a claim no longer has to be released to keep an issue
  pickable. The TTL replaces v1's mandatory release, whose script swallowed every error
  (`2>/dev/null || true`) and could silently leave an issue unpickable forever.

---

## `triage scratch`

**Invocation**

```
fabrika triage scratch 4312 --slug authored --token <claim-token> [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue this lane holds the claim on |
| `--slug` | string | yes | — | the file's leaf name: kebab-case, ≤5 words, no path separators |
| `--token` | string | yes | — | the token `triage claim` handed THIS lane — what keys the namespace |
| `--repo` | string | no | resolved | the repository |

**Output** — machine channel. One absolute path:
`<temp root>/fabrika-triage/<session-id>/<issue>-<claim-nonce>/<slug>`. The directory is created if
absent, so the path is writable the moment it is printed; the leaf itself is not created. There is no
`--json`: the answer is one path, and an object around it would carry nothing the path does not.

**The claim nonce is in the key, and that is the whole verb.** A fan-out of triagers runs under one
`$CLAUDE_CODE_SESSION_ID`, so a namespace keyed on the session alone hands every lane the same
directory — and a working file under a fixed name like `authored.md` then overwrites a sibling's
silently. That happened on 2026-08-20 across #6597/#6189/#6146 and was caught only because the
clobbered content happened to be a different issue's body
([#6630](https://github.com/kamp-us/phoenix/issues/6630)); the failure it points at is one issue's
authored body posted onto another. Keying on the lane makes the collision unconstructible rather than
detectable, exactly as `build scratch` already does for build lanes
([#6037](https://github.com/kamp-us/phoenix/issues/6037)). The nonce is read off the token the
**caller** holds, never off the winning marker — that string is the same for two lanes of one
session, which is how keying on it re-opens the hole it closed.

**Holding the claim is a precondition here, unlike everywhere else in this group.** The five mutating
verbs pass when nobody holds a claim, because an unclaimed issue is the ordinary first-triage case.
A scratch path *is* the lane, so a caller that cannot prove one has nothing to be allocated a
directory under: no live marker of this lane, or a marker that lost the race to a sibling, is exit
`19` and no path on stdout.

**The printed path is machine-local and must never reach a posted artifact.** `enrich`, `split`,
`park` and `kill` red on it (`5`) — the temp roots it lives under are three of the leak predicate's
structural shapes.

**Exit status**

| Code | Trigger |
|---|---|
| `10` | `--slug` carries a path separator, or is not a kebab-case leaf |
| `11` | the issue's comment list could not be read, or its markers could not be ordered — the claim is UNKNOWN |
| `19` | proven: this lane holds no live claim on the issue |

`1` additionally covers the two identity refusals and the allocation failure, as the errors table
below states. `7`, `8` and `9` are unreachable: this verb writes nothing to GitHub and reads no issue
record, so it has no write to fail and no read-back to mismatch.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage scratch: --slug "<s>" must be a kebab-case leaf, no path separators.` | 10 | refusal |
| `triage scratch: CLAUDE_CODE_SESSION_ID is unset — refusing to key a scratch namespace on an unattributable session.` | 1 | refusal |
| `triage scratch: CLAUDE_CODE_SESSION_ID is not a single token — a marker stamped with it would not read back as this session.` | 1 | refusal |
| `triage scratch: CLAUDE_CODE_SESSION_ID is not one path segment — it cannot name a directory of its own.` | 1 | refusal |
| `triage scratch: --token "<t>" is not a claim token (triage:<session-id>:<uuid>) — which lane is asking is not stated.` | 1 | refusal |
| `triage scratch: --token "<t>" carries session <s>, but this run is session <mine> — a lane names itself, never another.` | 1 | refusal |
| `triage scratch: cannot read #<n>'s comments in <repo>: <reason> — the claim on it is UNKNOWN, so no path was allocated.` | 11 | refusal |
| `triage scratch: cannot resolve the claim on #<n> in <repo>: <reason> — no path was allocated.` | 11 | refusal |
| `triage scratch: this lane holds no live claim on #<n> — run \`fabrika triage claim <n>\` and act only on \`won\`.` | 19 | refusal |
| `triage scratch: #<n> is held by the lane on nonce <nonce>, not by this one — back off.` | 19 | refusal |
| `triage scratch: cannot create <dir>: <reason>` | 1 | refusal |

**Scope** — the issue's comments, paginated, filtered to the marker prefix, with the scanned count on
stderr like every other read in this group.

**Examples**

```
$ fabrika triage scratch 4312 --slug authored --token triage:b2e1-…:5f1c9a20-…
triage scratch: scanned 3 comments in kamp-us/phoenix.
/var/folders/xy/T/fabrika-triage/b2e1-…/4312-5f1c9a20/authored
```

A sibling lane of the same session, on the same issue and the same slug, is handed a different
directory — which is the property the verb exists for:

```
$ fabrika triage scratch 4312 --slug authored --token triage:b2e1-…:7c3d0e91-…
/var/folders/xy/T/fabrika-triage/b2e1-…/4312-7c3d0e91/authored
```

```
$ fabrika triage scratch 4312 --slug authored --token triage:b2e1-…:5f1c9a20-…
triage scratch: this lane holds no live claim on #4312 — run `fabrika triage claim 4312` and act only on `won`.
$ echo $?
19
```

**Grounding**

- `packages/fabrika-cli/src/build/scratch-verb.ts` — the same allocator for build lanes, whose
  docblock records the five clobbers session-only keying cost (#4516, #4544, #4875, #4692, #6037).
- The `build` skill makes its path the only sanctioned one ("Scratch files go only where this
  prints"); this verb is what lets the triage skill say the same thing.

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
`outcome`, `marker` (boolean — was the agent footer present), `operator` (boolean — was the author a
configured operator account), and `reason`. `marker` and `operator` stay separate fields because
they are separate facts: an `agent` answer with `marker: false` is the ruling below firing, and a
caller chasing the emitter gap needs to see which one decided.

**Two agent signals, and the second one is config-bound.** ADR 0159 made the footer the signal
because every filing showed the same account, so authorship carried no information. The founder's
2026-08-09 ruling on #4619 narrows that: a filing authored by an account in the **operator set** is
agent-reported whether or not the footer is present, because footer-absence there reflects the
emitter gap #4619 tracks, not a human author. Footer-absence from **any other author** is unchanged
— still human-owned, and never auto-closed except by a `triage kill --duplicate-of` fold, which
#6070 licensed whatever the provenance.

**The operator set is an input, resolved from `$FABRIKA_OPERATOR_ACCOUNTS`** (comma- or
whitespace-separated logins, a leading `@` tolerated, compared case-insensitively). It is a *set*
rather than one account because the operator runs more than one, and it is configuration rather than
a literal in source because a GitHub handle baked into a released package is an operator identity
leaking into a shared artifact (#2393) — and a set nobody can widen without a release. **Unset or
blank yields the empty set**, which reduces the verb to ADR 0159's footer-only rule: a missing config
can never make a filing newly close-eligible.

**The footer's shape, from the emitter.** `report file` composes it with `renderFooter`
(`packages/fabrika-cli/src/report/compose.ts`), which emits `` `---\n<sub>` `` then the present fields
joined with ` · ` then `</sub>`. Two fields are always there — the literal `Filed by an agent` first,
and a UTC timestamp last, un-backticked. Three are droppable — `` session `x` ``, `` model `x` ``,
`` branch `x` `` — and **a dropped field takes its ` · ` separator with it**, so a sparse footer is
still a footer and this verb must not require any of the three.

**This verb matches a line beginning `<sub>Filed by an agent`, and that deliberately diverges from
`report`'s own check.** The shipped detection in
`packages/fabrika-cli/src/report/file-verb.ts` is the bare substring
`issue.body.includes("Filed by an agent")` — not line-anchored. That is correct *there*: it is a
read-back over a body the same process just composed, so nothing else can be in it. Here the body is
foreign, and a bare substring fails **open toward `agent`** — an issue that merely *quotes* the
phrase (a bug report about the footer, a pasted body, a discussion of ADR 0159) would answer `agent`,
and `agent` is the close-eligible direction. Anchoring to the emitted line shape makes the failure
land on `human`, which is the protected one. The divergence is stated so a later reader does not
"fix" it back into agreement.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the issue is proven absent (404) — there is no body to test |
| `11` | the issue could not be read — the outcome is UNKNOWN, never `human` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage provenance: issue #<n> not found in <repo>.` | 7 | refusal |
| `triage provenance: cannot read #<n> in <repo>: <reason> — the provenance is UNKNOWN; refusing to default it.` | 11 | refusal |
| `triage provenance: #<n> has an empty body — answering human (fail-closed).` | 0 | notice |
| `triage provenance: #<n> in <repo> — the author is a configured operator account, so the filing is agent-reported whether or not the footer is present (#4619 ruling).` | 0 | notice |

**Scope** — one issue's body and its author login, read as typed JSON rather than through
`jq -r .body`, which errors on the unescaped control characters GitHub issue bodies carry and yields
empty in a loop. A payload carrying no author reads as the empty login, which is never a member of
the operator set — so an unreadable author degrades to the footer-only rule, the protected direction.

**A present-but-empty body answers `human`; an unreadable one refuses.** Those are different facts
and this verb keeps them apart. An empty body is a measurement: the body is there, it carries no
footer, and the protective reading of "no footer" is `human`, because the only irreversible act
downstream is a kill. The author is tested **first**, so an operator's empty-bodied filing answers
`agent` — the ruling is about who filed it, not how much it says, and `--confirm` is still the guard
on the close. The stderr notice says the answer was defaulted, so a caller can tell a
measured `human` from a fail-closed one. An **unreadable** body is not a measurement at all, and
answering `human` over it would be a verdict manufactured from a failed read — the same fusion the
`7`/`11` split exists to prevent. The protection survives either way: `triage kill` refuses on a
`human` verdict *and* refuses on an unreadable body, and now says which happened.

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
{"outcome":"agent","marker":true,"operator":false,"reason":"the 'Filed by an agent' marker is present in the body"}
```

```
$ FABRIKA_OPERATOR_ACCOUNTS=<operator-login> fabrika triage provenance 5111
agent
```

**Grounding**

- ADR 0159 — filing provenance, not authorship, is the signal. Its premise, that authorship is
  unusable because every filing shows one shared account, is what the #4619 ruling narrows: the
  operator's own account is now a *positive* agent signal, and only that account.
- Founder ruling on #4619, 2026-08-09 — an issue filed under the operator's own account is
  agent-reported and close-eligible, footer or no footer; unchanged for a genuine third-party human
  filing. It settles a live cost: filings were parked at `status:needs-info` on footer-absence alone
  and then closed by hand anyway (#5098, #5111).
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
fabrika triage homes [--roadmap <path>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--roadmap` | string | no | `roadmapFile` in `.fabrika.jsonc`, itself defaulting to `ROADMAP.md` | the roadmap file whose `## Arcs` and `## Campaigns` tables the open milestones are joined to. Unflagged, the verb resolves the declared path first; a `.fabrika.jsonc` it could not read refuses `11` rather than falling back to the shipped name |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

There is no lane flag: the lane set is `boardVocabulary.standingLanes` in `.fabrika.jsonc`, and a
config that could not be read or decoded refuses `11` on the same terms as `roadmapFile`.

**Output** — machine channel. The first line is the outcome token `homes`. Then one tab-separated
line per candidate — `<kind>`, `<key>`, `<label-or-title>` — where `<kind>` is `milestone` or `lane`.
A `milestone` row's `<key>` is its **number** (the value `triage apply --home` takes) and its third
column is the milestone title; a `lane` row's `<key>` is its label name and its third column is a
fixed meaning string:

| Lane | Third column, verbatim |
|---|---|
| `wayfinder:backlog` | `fog — uncharted work upstream of any arc` |
| `axis:pipeline-hardening` | `the standing pipeline and reliability lane` |
| any other declared lane | `a standing lane this repo declares` |

**This table is the only place in this spec that enumerates a lane meaning.** The strings are
constants here rather than the repo's live label descriptions, so a description edit cannot change a
machine-channel answer — and no source this verb reads can gloss a lane some other repo declared, so
the third row says that instead of inventing one.

Milestone rows come first, ordered by number, then the lanes in the order the config declares them.

With `--json`, an object with keys `outcome`, `milestones` (array of `{number, title, roadmapRow}`),
`lanes` (array of `{label, meaning}`), and `scanned`.

**Every `active` campaign's milestone is marked `running`.** That campaign is closed to new intake
unless the work is `p0` or blocks one of that milestone's own in-flight lanes, so its row carries a
fourth tab-separated column, verbatim `running: p0/blocker only`, and its `--json` object carries
`"running": "p0/blocker only"` as a fourth key. Every other row is unchanged on both channels — no
fourth column, and no `running` key — so a reader written against the pre-marker shape still parses.
A marked milestone is still listed: the two exceptions are real work, and a removed row cannot
carry them. This verb states the subtraction and stops; where excluded work goes instead is the
caller's by-fit judgement, and no output here names a destination.

**Which milestone is running is data, never a literal in this spec or in the verb.** It is the
`State` column of `ROADMAP.md`'s `## Campaigns` table — the same permission `build pick` fences on
(ADR 0304), read through the same parser, off the roadmap text this verb has already read for the arc
join. Moving to the next campaign is a `ROADMAP.md` edit and never a code or skill edit; `--roadmap`
moves both reads together. The table's three states are the ones the fence already reads:

| `## Campaigns` | Rows marked | stderr |
|---|---|---|
| one or more rows are `active` | every `active` campaign's milestone row, if it is open | `triage homes: campaigns: 1 active — <name> (#<n>).` — or, for N > 1, `triage homes: campaigns: <n> active — <name> (#<a>), <name> (#<b>).` |
| absent, empty, or every row `paused`/`done` | none — the answer is exactly the pre-marker one | `triage homes: campaigns: none active — scope fence inert.` |
| reads but does not parse | none | `triage homes: campaigns: unreadable — <reason>.` |

A malformed table is **never** rendered as "no milestone is running", and it does not refuse: a home
list is still the right answer, and the stderr line is where the defect is named. An `active` campaign
pinning a milestone that is closed or absent from the open set marks no row and passes.

**Only open milestones appear, and each is joined to its roadmap arc/campaign row.** `roadmapRow` is
`null` for an open milestone no roadmap row pins, which is itself a signal worth seeing rather than a
row to hide.

**A lane row is offered only where this repo BOTH declares the lane and carries its label.** The
declared set is `boardVocabulary.standingLanes` in `.fabrika.jsonc`, whose shipped default is
phoenix's pair; the verb then reads the repo's own label set and drops every declared lane the board
does not carry. Both halves are load-bearing. The declaration alone is a claim about a board — in
`kamp-us/demlik`, where neither label exists, the pair printed as assignable homes and a triager took
one, classified the whole issue, and only then hit a failed label write naming a label rather than
the real cause (#6440). So the presence read is the same evidence the later `triage apply --lane`
write depends on, taken before the menu is printed rather than after the work is done.

**A repo declares no lanes by writing `"standingLanes": []`**, and then reads no labels at all —
there is nothing to filter — and prints no lane row. The empty list is the one explicitly-empty
`boardVocabulary` sub-key that decodes rather than refusing: the other four turn a gate off, while
zero lanes turns nothing off and says every issue homes on a milestone. An **absent** key is not the
same declaration — it falls to the shipped pair. `triage apply --lane` refuses over an empty set on
`10`, naming the empty key rather than enumerating nothing.

Neither case is a refusal: a home list over milestones alone is the right answer, and stderr carries
which lanes were declared and which of them the board carries:

| Declared set | stderr |
|---|---|
| empty | `triage homes: standing lanes: this repo declares none.` |
| all present | `triage homes: standing lanes: 2 of 2 declared carry a label in <repo>.` |
| some absent | `triage homes: standing lanes: 0 of 2 declared carry a label in <repo> — not offered: wayfinder:backlog, axis:pipeline-hardening.` |

The dropped labels are named, not merely counted: the gap between what the config asserts and what
the board carries is the defect, and a bare `0 of 2` sends the reader back to the config to find out
which names it meant.

**An unreadable label list is `11`, never "this repo has no lanes."** That reading silently shortens
the menu, which is the failure this whole surface is built against — a caller cannot tell a repo with
no lanes from a repo it could not look at.

This follows ADR 0286's ruling that lanes come from the repo, with one departure it names: 0286 puts
them under a `lanes` key with **no** shipped default, and the key that exists today is
`boardVocabulary.standingLanes`, which defaults to phoenix's pair on an absent key. Evicting that
default is [#6469](https://github.com/kamp-us/phoenix/issues/6469), which owns the whole move —
0286's `lanes` key, the compiled-in label/meaning enumeration, and the readers that go with the set.
Until it lands, two things contain the default: the presence filter, so it asserts nothing about a
board that never created the labels, and the empty declaration, so a repo can say outright that it
runs none.

**The join, stated rather than left to the implementer** — this is the verb's whole split test, so it
is the one thing that must not be inferred. `ROADMAP.md`'s `## Arcs` and `## Campaigns` tables are
`| <name> | <milestone> | <state> |`, where the milestone cell is `#<number>` — the same
row-to-milestone-by-number binding `roadmap-guard` already enforces. So: **the join key is that
`#<number>` matched against the milestone's number, never the title**, and `roadmapRow` is the row's
**first column** — the arc or campaign name. The `State` column is not read: this verb reports what
exists, and whether an arc is active is a question for the caller, not a filter here. A milestone no
row pins yields `null`; a row pinning a milestone that is closed or absent contributes nothing.

Matching on the title would be the obvious shortcut and it is wrong — an arc named `Geçit` pins a
milestone titled `Sözlük — search and discovery`, and the two share no substring.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the repository has zero open milestones, **or the roadmap parsed to zero arc rows** — zero scope |
| `11` | the milestone list, the repo's label set, the roadmap file or `.fabrika.jsonc` could not be read — the outcome is UNKNOWN |

A malformed `## Campaigns` table is not on this table: it marks no row and names itself on stderr.
The marker is an annotation on an answer this verb can give without it, so refusing over one would
withhold the home list a triager needs.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage homes: cannot read milestones in <repo>: <reason> — the home list is UNKNOWN, never empty.` | 11 | refusal |
| `triage homes: cannot read the labels in <repo>: <reason> — which standing lanes this board accepts is UNKNOWN, never none.` | 11 | refusal |
| `triage homes: .fabrika.jsonc is refused — <reason>, so which standing lanes this repo runs is unread; the homes list is UNKNOWN, never short.` | 11 | refusal |
| `triage homes: cannot probe the roadmap at <path>: <reason> — the home list is UNKNOWN, never empty.` | 11 | refusal |
| `triage homes: cannot read the roadmap at <path>: <reason> — the home list is UNKNOWN, never empty.` | 11 | refusal |
| `triage homes: <repo> has 0 open milestones — refusing to answer, since "no home exists" routes to a kill (ADR 0092).` | 7 | refusal |
| `triage homes: the roadmap at <path> parsed to 0 arc rows — the table grammar changed or the file is truncated; refusing to answer over an unjoinable roadmap.` | 7 | refusal |

**Both "cannot read" cases are `11`, not `1`.** They were `1` in an earlier revision, which fused an
unreachable GitHub and an unreadable file with a mistyped flag — and this verb's answer feeds a
routing decision whose fallback is a kill. A caller that cannot tell "no homes" from "I could not
look" will route work irreversibly on the second one.

**A readable roadmap that yields zero arc rows is a failed parse, not a repo with no arcs.**
The grammar is a table this verb does not own, so a grammar change silently empties the join; reading
that as "no homes exist" would route work to a kill. Zero *campaign* rows is a legitimate state and
passes.

**An ABSENT roadmap is an answer, not either refusal (#5773).** A file that is proven not to exist is
a proven negative — the join is simply empty — so every open milestone lists with `roadmapRow: null`,
any standing lane the board carries lists beside them, and stderr carries
`triage homes: no roadmap at <path> — every milestone lists with no arc name.` The campaigns fence
reads the absent file as the empty document, so its scope line says `campaigns: none active — scope
fence inert.` The zero-arc-rows refusal above is reached only by a roadmap that *exists*, so the
grammar-drift guard keeps its teeth. This is the degrade disposition the rest of the corpus already
declares for `ROADMAP.md`; `homes` was the one reader treating it fail-loud.

**Absent and unreadable are separated by a filesystem probe, never by the text of a read failure.**
The verb asks `exists(<path>)` first: a probe that could not be *performed* refuses `11`, `false`
takes the absent path above, and only on `true` does it read — a read that then fails is the `11`
row. The `ReadFailed` this package raises flattens `NotFound` and `EACCES` into one `reason` string,
so matching on that string would be a guess dressed as a discrimination.

**Scope** — every open milestone in `--repo`, paginated, joined to the `## Arcs` and `## Campaigns`
tables of the roadmap file, read from the repo root the delivery layer already sets as the process
cwd (see the CLI convention's Delivery section) unless `--roadmap` overrides it. **Zero open
milestones is a refusal, not an answer**: an empty candidate list routes the skill toward a standing
lane or a kill, and a kill driven by a failed read is irreversible.

**On a `7` refusal stdout is empty and `--json` emits nothing** — the offered lanes go to stderr with
the refusal message, which is why the label read runs ahead of the milestone read. An earlier draft printed the lanes on stdout while withholding the outcome
token; that is a partial answer at a non-zero exit, which the shared conventions forbid and which
hands a byte-reading caller two rows and no token.

**Examples**

```
$ fabrika triage homes
homes
milestone	47	Sözlük — search and discovery
milestone	52	Merge-Gate Reliability	running: p0/blocker only
lane	wayfinder:backlog	fog — uncharted work upstream of any arc
lane	axis:pipeline-hardening	the standing pipeline and reliability lane
```

```
$ fabrika triage homes --json
{"outcome":"homes","milestones":[{"number":47,"title":"Sözlük — search and discovery","roadmapRow":"Geçit"},{"number":52,"title":"Merge-Gate Reliability","roadmapRow":null,"running":"p0/blocker only"}],"lanes":[{"label":"wayfinder:backlog","meaning":"fog — uncharted work upstream of any arc"},{"label":"axis:pipeline-hardening","meaning":"the standing pipeline and reliability lane"}],"scanned":2}
```

**Grounding**

- v1 `list-open-milestones.sh:11` issues `gh api "repos/$REPO/milestones?state=open"` with no
  `per_page` and no `--paginate`, capping candidates at GitHub's default 30 with no truncation
  signal — while "nothing fits" routes to an irreversible kill.
- v1 made the agent join milestones to the roadmap by hand from two sources, one of them silently
  truncated. The join is mechanical, so it belongs here.
- v1's `homing-guard` treats "homed" as `milestone !== null` and never checks the milestone is open or
  on-roadmap, so a closed milestone reports as a valid home. Offering only open, roadmap-joined
  milestones designs that mismatch out at the point of assignment rather than detecting it later.
- ADR 0072 §3 — curating the milestone set is a human roadmap act, so no verb here creates one.
- #6080 — a closing campaign kept taking every lane's follow-ups because nothing in this verb's
  output said which milestone was running, so triagers homed by title match. The marker is only a
  subtraction; enforcement is deliberately absent, since both exceptions are judgements a verb cannot
  check and a guard blind to them would refuse exactly the work the rule allows.

---

## `triage split`

**Invocation**

```
fabrika triage split 4312 --title "Editor loses focus after save" [--token <claim-token>] [--repo <owner/name>] [--json]
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
| `--token` | string | no | none | the claim token `triage claim` handed this lane; without it the guard reads the session alone and refuses once two lanes of it hold live markers |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One tab-separated line: `<outcome>`, `<number>`, `<url>`, where
`<outcome>` is `created` or `reused`. With `--json`, an object with keys `outcome`, `number`, `url`,
`matchedOn` (`"back-reference+title"` on `reused`, `null` on `created`), and `crossLinked` (boolean).

**`crossLinked` is `false` on every `reused`**, and that is a fact rather than a failure: a reuse
prints and stops before step 4, so no cross-link is attempted. The parent was cross-linked when the
child was first created. A caller must not read `"crossLinked":false` on a `reused` as a broken link.

**What the operation does, in order.** (1) Assert `status:needs-triage` exists in `--repo` (see
Scope). (2) Read the scope below. (3) On a match, print `reused` and stop — **the existing child's
body is not updated from stdin**, because a reuse is an idempotency answer, not an edit, and silently
rewriting a child someone may have already triaged would lose their work. (4) On no match, compose
and create the child. (5) Post a `split into #<child>` comment on the parent.

**Step 5 is best-effort and never changes the exit status.** A failed cross-link is reported on
stderr; the child exists either way, and mapping it to `8` would be a lie, since `8` means the create
outcome is unknown and here the create demonstrably landed. The durable trace is the child's own
back-reference, which is the key this verb reads on a re-run; the parent comment is for human readers.

**Both outcomes are answers and both exit 0**, and both print the same shape — a caller reads the
token, never a sentence. v1 printed two different English sentences from two different tools and made
every caller regex a number back out of prose.

### The child this verb creates

An earlier revision never said. Two things broke silently as a result, and both are why the shape is
pinned here rather than left to an implementer.

**The child carries `status:needs-triage`.** Without it the child is invisible to read 1 below — this
verb's own primary create-once read — so the read could never match anything this verb produced, and
every re-run would fire a fresh twin. The label is what makes read 1 load-bearing rather than dead
code against its own output. It is also simply correct: a freshly split child has not been triaged.

**The child carries the agent footer.** Without it `triage provenance` answers `human` and
`triage kill` refuses the child **forever** on `12` — a split child could never be killed, not even
as a duplicate of its own sibling. The footer comes from `renderFooter` in
`packages/fabrika-cli/src/report/compose.ts`; **import it, do not re-derive it**, and its field rules
(the literal first, the timestamp last, `session`/`model`/`branch` droppable with their separators)
apply unchanged.

The composed body, where `<STDIN>` is the caller's bytes:

```
<STDIN>

split from #<parent>

---
<sub>Filed by an agent · session `<id>` · model `<name>` · branch `<ref>` · <timestamp></sub>
```

The leak scan runs over this composed body **after** composition, so nothing the verb itself appends
can escape it — the same ordering `report file` uses.

**The create-once key.** The verb writes `split from #<parent>` into the child body itself, so the key
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
| `3` | stdin was read and held nothing |
| `5` | the composed child body carries a machine-local path |
| `6` | the child body is a bare `@` path reference — the body never arrived |
| `7` | the parent is proven absent (404), is closed, or `status:needs-triage` does not exist in the repository |
| `8` | the create failed — UNKNOWN whether a child landed |
| `9` | the child was created but the read-back does not match |
| `11` | a precondition read failed — the parent, its comments, the claim on it, the queue, the timeline, or a candidate's body |
| `17` | a live claim marker on the parent names another session — or, when `--token` named this lane, another lane of this one; a tokenless call is refused once two lanes of its session hold live markers |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage split: no body on stdin — pipe the child body in.` | 3 | refusal |
| `triage split: parent #<n> not found in <repo>.` | 7 | refusal |
| `triage split: parent #<n> is already closed.` | 7 | refusal |
| `triage split: cannot read #<n>'s comments in <repo>: <reason> — the claim on it is UNKNOWN; nothing was written.` | 11 | refusal |
| `triage split: cannot resolve the claim on #<n> in <repo>: <reason> — nothing was written.` | 11 | refusal |
| `triage split: #<n> is claimed by session <s> — refusing to mutate another session's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage split: #<n> is claimed by lane <l> of this session, not by this lane (<nonce>) — refusing to mutate a sibling lane's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage split: #<n> carries live claim markers from more than one lane of this session and this call names none, so which lane is asking is UNKNOWN — pass the `--token` `fabrika triage claim <n>` handed this lane.` | 17 | refusal |
| `triage split: label status:needs-triage does not exist in <repo> — refusing to create a child over a queue that would scan nothing (ADR 0092).` | 7 | refusal |
| `triage split: the child body carries a machine-local path at line <k> (<class>) — rewrite it repo-relative.` | 5 | refusal |
| `triage split: the child body is a bare "@" path reference — the body never arrived. Send it on stdin.` | 6 | refusal |
| `triage split: cannot read <what> in <repo>: <reason> — UNKNOWN whether a child already exists; refusing to create a possible twin.` | 11 | refusal |
| `triage split: create failed: <reason> — UNKNOWN whether a child landed; re-run this verb, which will reuse it if it did.` | 8 | refusal |
| `triage split: child #<n> created but its body read back changed — inspect before splitting further.` | 9 | refusal |
| `triage split: could not cross-link parent #<p> to child #<c>: <reason> — the child exists; add the comment by hand.` | 0 | notice |

**Scope** — a zero-scope precondition, then two REST reads, neither of them the search index.

**The precondition.** Before read 1, the verb asserts `status:needs-triage` exists in `--repo`'s label
set. Read 1's label is a hardcoded literal while `--repo` is generic, so a renamed label or a
scope-limited token returns HTTP 200 with `[]` — **not** a read failure, and therefore not `11`. The
verb would fall straight through to `created` and mint a twin. Without this check the one verb built
to be fail-closed is the ADR 0092 fail-open. Absent label ⇒ `7`, with the same shape of message
`triage queue` uses.

**Read 1 — the intake queue. This is the primary, and the create-once guarantee rests on it.**
`GET /repos/{repo}/issues?state=open&labels=status:needs-triage&per_page=100`, paginated. Two
properties make it the load-bearing half: it is the **read-after-write consistent** source, and the
children this verb creates carry that label by construction.

**"Read-after-write consistent" is the repo's stated premise, not a verified platform fact.** It is
asserted in roughly a dozen places (`packages/fabrika-cli/src/report/dedup-verb.ts`,
`packages/pipeline-cli/src/tools/split-guard/github.ts`, and on down) and grounded in none of them —
no doc link, no measurement. It is recorded here as the premise this design rests on so that if it is
ever falsified, the thing to re-derive is obvious.

**Read 1 returns titles, never bodies**, so the match runs in two stages. The list read projects at
transport — `packages/fabrika-cli/src/io/issues.ts` issues a `--jq` of
`"\(.number)\t\(.title)"`, so bodies never leave `gh` — which means:

1. **Narrow by normalized title first.** Keep only rows whose normalized title equals the normalized
   `--title`. Usually zero or one survive.
2. **Then fetch each survivor's body** with the per-issue `getIssue` in the same module and test it
   for `split from #<parent>`. `getIssue` returns a three-way `Existence`: `Present`, `Absent`, or
   `Unknown`. **An `Unknown` on any survivor is `11`** — that survivor might be the child, and
   creating over an unread candidate is exactly the twin this verb exists to prevent.

An N+1 fetch is the cost of a list read that carries no bodies. Narrowing first is what keeps N at
roughly one.

**Read 2 — the parent's timeline. Supplementary, and explicitly not the guarantee.**
`GET /repos/{repo}/issues/{parent}/timeline`, event type `cross-referenced`, with the child number at
`source.issue.number`. It reaches children that have already been triaged out of the queue, which
read 1 cannot see, and that is the only reason it is here. Three constraints, all of them the repo's
own findings about this endpoint:

- **It lags.** `packages/pipeline-cli/src/tools/merge-queue-classify/` records ~30–60 minutes of
  observed staleness on this endpoint (#4057) and states that "an ejection that has not yet surfaced
  in the timeline reads identically" to one that never happened. A read that can be that far behind
  cannot carry a create-once guarantee for a child made seconds ago.
- **It pages at 30 by default**, so `--paginate` is mandatory and the `--jq` streams rather than
  buffering the whole timeline (#4193).
- **A failed read is `11`**, never a silent `created`.

So: **the create-once guarantee rests on read 1.** Read 2 widens the net for older children and
narrows nothing. An earlier revision described both halves as "read-after-write consistent", which
was wrong about this one and would have let an implementer trust the lagging source.

**Neither half may be the search index.** The index is eventually consistent, so a child created
seconds ago is invisible to it — which is precisely the five-second twin window (#3462/#3463) this
verb exists to close. `report dedup` may use the index because it is advisory; a create-once guard
may not.

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
- #4057 / #4193 — the timeline endpoint's observed staleness and its 30-per-page default. Both are
  the reason it is the supplementary half here rather than the guarantee.

---

## `triage enrich`

**Invocation**

```
fabrika triage enrich 4312 [--epic] [--token <claim-token>] [--repo <owner/name>] [--json]
```

The rewrite — or, with `--epic`, the pitch — arrives on **stdin only**, for the reason given under
`triage split`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to enrich |
| `--epic` | boolean | no | `false` | wrap the original in place under a fixed header and head the pitch above it, instead of writing a rewrite over it; stdin carries the pitch, not a rewrite |
| `--token` | string | no | none | the claim token `triage claim` handed this lane; without it the guard reads the session alone and refuses once two lanes of it hold live markers |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the rewritten body that goes above the preserved original — with `--epic`, the pitch's five field lines instead: `**Problem:**`, `**Arc:**`, `**Appetite:** <N> cycles`, `**Rabbit-holes:**`, `**No-gos:**`, one per line |

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

<!-- fabrika:enriched issue=<N> mode=rewrite -->
<details>
<summary>Original report (verbatim)</summary>

<ORIGINAL>

</details>
```

`--epic` mode emits the **pitch** instead of a rewrite, above a fixed header and the wrapped
original, where `<PITCH>` is stdin verbatim:

```
## Pitch

<PITCH>

## Epic — awaiting plan

`plan-epic` appends its plan and dependency topology below.

<!-- fabrika:enriched issue=<N> mode=wrap -->
<details>
<summary>Original brief (verbatim)</summary>

<ORIGINAL>

</details>
```

**The `<!-- fabrika:enriched … -->` line is the re-enrich marker**, described in full under the
detector below. It renders as nothing, it is the boundary between the region this verb owns and the
bytes it must never touch, and it carries the issue number it was written on.

An epic's original is consumed verbatim by the downstream planning step, so a **rewrite** above it
would fork the brief — which is why this mode never takes one. **A pitch is not a rewrite**: it is
the five-field bet `pitch-guard` requires in the body of every `status:triaged` `type:epic`
(`packages/pipeline-cli/src/tools/pitch-guard/pitch-guard.ts:219-223` — an epic is lane-entering
unconditionally, with no parent test — and `:244-246`, where an absent `## Pitch` section is the
red), and this is the only verb in the group that writes a body. An earlier revision read no stdin
here at all, which left an epic **structurally unable to carry the section a CI guard fires on** at
the very label `triage apply` writes.

**Nothing this mode adds can reach the brief.** A planner splices around the envelope: it anchors on
the exact headings `## Dependencies` and `## Plan (plan-epic)` and preserves every other byte
verbatim, so neither heading above is an anchor it can cut on, and the wrapped original is untouched
bytes either way. That is an agreement rather than a coincidence — the envelope is a wire format
fabrika owns, and a splicer conforms to it by pinning fabrika's golden fixture in a test of its own
(ADR [0251](../../../../.decisions/0251-shared-formats-are-pinned-not-reimplemented.md)), so a
reworded anchor set reds a test on the side that reworded. What
`plan-epic` *does* change is where the wrap sits: `## Plan (plan-epic)` and `## Dependencies` both
land **below** it, so this mode's envelope stops being terminal the moment the epic is planned. The
re-enrich detector below tests position nowhere, in either mode, for exactly that reason; a re-enrich
replaces the pitch and the header from fresh stdin and preserves the wrap — and everything under it —
unchanged, exactly as the default mode replaces a rewrite.

**Stdin carries the five field lines, not the section heading.** The verb writes `## Pitch` itself,
so the heading always matches the guard's anchor rather than a caller's typing; a caller who sends
the heading too gets two of them, and the guard reads the empty section between them as a pitch
missing all five fields — loud at the seam, never a silent pass. The five lines, stated here rather
than deferred to another skill's prose:

```
**Problem:** <who has it, and what breaks or stalls for them today>
**Arc:** <the home just assigned — the milestone title, or the standing lane>
**Appetite:** <N> cycles
**Rabbit-holes:** <the named traps — the specific ways this overspends if left unbounded>
**No-gos:** <what this deliberately does not do>
```

**The label opens the line.** The guard reads a field as `<optional emphasis><name><optional
emphasis>:` anchored at line start over optional spaces and tabs, tolerating case and `Rabbit holes`
for `Rabbit-holes` (`pitch-guard.ts:89-93`) — so a bulleted `- Problem: …` does **not** read as a
field. Field order is not load-bearing; `Appetite` must parse as a whole positive number of cycles
(`:104-109`).

**`## Epic — awaiting plan` is a heading, and that is load-bearing rather than cosmetic.** The guard
reads the pitch section from `## Pitch` to *the next heading of any level, or end of body*
(`pitch-guard.ts:73-80`), so a plain bold line there would run the section on **into the wrapped
original** — and a field the draft omitted could then be satisfied by any `**Problem:**`-shaped line
the reporter happened to type. Section scoping is the guard's own defence against exactly that read
(its comment: *"Scoping field extraction to this section is what keeps a plan-epic body's
`### Problem & who has it` from reading as a pitch field"*), and this heading is what keeps that
defence true here.

**That is measured, not reasoned.** `readPitch` was run on 2026-08-03 over both envelopes, with a
draft deliberately missing `Problem` and a brief containing a `**Problem:**` line. With this
heading: `malformed ["Problem"]` — caught. With a bold line in its place: `present`, appetite 2 — a
pitch the drafter never wrote, passing on the reporter's prose. A caller who sends the `## Pitch`
heading too reads `malformed` on all five, and the canonical envelope reads `present` and resolves
`pitched` against a `pitch-approved: appetite 2 cycles` comment. **Do not demote this heading back
to bold text.**

**The pitch is drafted here and judged nowhere here.** Well-formedness and founder approval are
`pitch-guard`'s, at the `status:triaged` seam `triage apply` trips; this spec computes no second
verdict on a gated question, which is the same reason a `triage pitch-check` verb is not derived.
This verb refuses only what it can refuse about text the caller just wrote — empty (`3`), a
machine-local path (`5`), a bare `@` reference (`6`), and an acceptance-criteria block the wire
reader rejects (`15`, below) — and `--epic` **adds no exit code of its own**: reaching those same
refusals is the removal of a restriction, not a new outcome.

**The re-enrich detector is the marker this verb writes — one rule, mode-independent** (founder
ruling on [#4866](https://github.com/kamp-us/phoenix/issues/4866), 2026-08-08, option (b)). A body
counts as already-enriched **when, and only when, it carries a marker line bound to this issue**:

```
<!-- fabrika:enriched issue=<N> mode=<rewrite|wrap> -->
```

matched **anchored to a whole line**, never as a substring — a filing that *mentions* the marker in
prose is an ordinary filing here, and reading its prose as a marker would overwrite the reporter's
own text above the mention.

**This supersedes the two shape-based detectors this section specified before the ruling** — default
mode's terminality-plus-`Original report (verbatim)` test, and `--epic`'s three envelope anchors. The
reasoning that produced them is not withdrawn: each was correct about its own mode, and the
`--epic` rule's position-independence was itself the ruled fix to a real compounding bug
([#4850](https://github.com/kamp-us/phoenix/issues/4850)) — once `plan-epic` runs,
`## Plan (plan-epic)` and `## Dependencies` sit *below* the wrap (`plan-epic` Step 2 writes the plan
"below the untouched brief", and a first-time plan with no topology yet appends at end of body), so a
terminality test stops matching on every planned epic. What the ruling settles is that **both** were
mode-scoped and keyed on disjoint literals, so neither could recognise the other mode's envelope. A
re-run in the other mode therefore fell through to "first enrichment ⇒ wrap" and nested the whole
existing envelope — pitch, header, plan, topology and the previous provenance boundary — inside a
fresh block, compounding per run and labelling authored content as the reporter's own text. That path
is ordinary rather than exotic: `triage apply`'s owned-facet table owns `^type:`, so re-classifying an
enriched issue to `type:epic` and re-enriching with `--epic` is a supported sequence with no guard
between its steps.

A marker is written by this verb and by nothing else, so presence *is* the answer, whichever mode
wrote it and whichever mode is re-running. The class dies for every marker-bearing body rather than
for one axis of it.

**The marker is also the boundary.** It sits on its own line immediately above the opening
`<details>`, so "is this enriched?" and "where does the authored region end?" are the same read.
Nothing has to locate a `<details>` opener or a summary literal — which is precisely what made the
retired detectors mode-scoped. **On a match the verb replaces the authored region only — byte 0 up to
the marker — and preserves the marker's line onward, the block *and every byte below it*, verbatim**
(it re-emits a fresh marker carrying the mode that just wrote the region). Preserving the block alone
would be the same destruction by a shorter route: it would delete the plan and the dependency
topology `plan-epic` wrote underneath. Default mode's match is the same rule where "everything below"
is empty.

**The split is on the FIRST marker in the body.** The verb always writes its own marker *above* the
preserved region, so a marker carried *inside* preserved content — a quoted envelope, a foreign paste
that was wrapped — is always the later one and can never be mistaken for the boundary.

**Legacy is a self-healing migration, and is meant to be deleted.** On meeting a **pre-marker**
wrapped body the verb recognises the two v1 envelope shapes below — default mode's terminality test,
and `--epic`'s three anchors — **does not double-wrap**, and **stamps the marker in passing**. Every
body that branch can match therefore converts on its next enrichment and never returns to it. It is
one-time code that retires with v1-backlog absorption (founder mandate, map #4891); an implementation
keeps it separable so retiring it is a delete rather than an excavation. The shapes are used **only**
for a body carrying no marker at all — a body whose marker binds *another* issue short-circuits ahead
of them, so the legacy door cannot re-admit the impersonation the binding exists to refuse.

### The two v1 envelope shapes — legacy recognisers only, never the detector

Restated here **only** as what the legacy branch recognises, so the clause above resolves against a
specification rather than a label, and so the retirement has something to delete. These are **not**
the detector: detection is marker presence, and it is mode-independent. They decide nothing about a
marker-bearing body — a body whose marker binds *another* issue short-circuits ahead of them
(`detect`, `enrich.ts:95-107`) — and they are consulted **only** for a body carrying no marker at
all. Their whole purpose is that a **pre-marker** body is preserved rather than double-wrapped. Both
live in exactly one place, `packages/fabrika-cli/src/triage/enrich-legacy.ts`, whose retirement is a
whole-file delete plus the injected `legacyPreserved` argument at `detect`'s call sites.

**v1 default mode — terminality plus the report literal.** All three conditions hold: the body
carries a line that is exactly `<summary>Original report (verbatim)</summary>`; that line's
`<details>` opener sits immediately above it, blank lines aside; and the body's **last non-blank
line** is `</details>`, so the block closes at end of body. The preserved region is that opener line
onward, to end of body.

**v1 `--epic` mode — three anchors, position-independent** (#4850's ruled option (a)). All three
conditions hold: the body's **first** line is exactly `## Pitch`; the body carries the exact line
`## Epic — awaiting plan`; and the first `<summary>Original brief (verbatim)</summary>` line sits
**below** that header. The preserved region is that summary's `<details>` opener line onward, to end
of body.

Every line test above compares the line with trailing whitespace stripped, and each anchor resolves
to its **first** occurrence in the body.

**The quote-protection is preserved, and it moved onto the binding.** The strict form is required for
the same reason `triage provenance` pins its footer match, but the failure direction is worse:
provenance fails *open* toward a wrong verdict, while a loose re-enrich detector fails
*destructively* — "replace everything above the boundary" applied to an issue that merely **quotes**
an enrichment envelope (a bug report about this very format, a pasted body) silently deletes every
line above the paste, on a public issue, irreversibly. In this repo an issue pasting a fabrika
envelope is an ordinary filing, not an exotic one.

**The issue number bound into the marker is what holds that line, and it holds a strictly wider one
than the anchors did.** A pasted envelope carries the marker of the issue it was written on, so on
*any other* issue it reads as **fresh** and is wrapped rather than partially overwritten — whatever
the paste's shape, and wherever in the body it sits. That covers both the quote-impersonation case
the retired anchors defended against **and** the residual the section previously had to state as
uncovered: a body whose *first* bytes are a raw paste of a complete envelope. That case was
byte-indistinguishable from an enriched body under any content-derived test, and terminality did not
cover it either (a paste that ends the body is terminal). The section named the answer at the time —
*"if it ever bites the answer is a marker the verb writes and a paste does not, never a weaker
anchor"* — and this is that answer.

The `--epic` anchors, which the legacy branch still uses as recognisers, survive a plan because a
splicer cuts only on `## Dependencies` and `## Plan (plan-epic)`: `## Pitch` and
`## Epic — awaiting plan` are bytes it never touches, and so is the marker, which is neither of those
two headings. That is the splicer's obligation to this format rather than a fact fabrika inherits —
which side owes which is settled in ADR
[0251](../../../../.decisions/0251-shared-formats-are-pinned-not-reimplemented.md).

**That survival is pinned executably, not only argued.** A splicer's unit tests run a real envelope
through a first-time plan and a re-plan and assert that the `<details>` block stops being terminal,
that the anchors still hold, that the wrapped original survives byte-for-byte, and that the summary
line never doubles. Under ADR 0251 the envelope those tests run is fabrika's committed golden
fixture, so a rewording here reds them; the block presently lives in
`packages/pipeline-cli/src/tools/epic-splice/epic-splice.unit.test.ts` with a hand-copied envelope
and is scheduled to split — fixture and detector to fabrika, preservation assertions to the splicer.
The marker rule is pinned on the verb's own side, in
`packages/fabrika-cli/src/triage/enrich.unit.test.ts`, which
reproduces the **retired** detectors in-test as controls: the cross-mode re-run they miss is asserted
to be recognised here, a pasted envelope bound to another issue is asserted to read as fresh, and a
legacy body is asserted to be recognised, preserved and stamped. Change the rule and those tests go
red, which is what keeps this section from drifting back into an assumption.

**Idempotency, stated as the other write verbs state theirs — and now unconditional.** Re-running
`enrich` on an already-enriched issue **converges**: it replaces the authored region from fresh stdin
and leaves the marker's line onward — the preserved original and every byte below it — unchanged, so
a second pass produces the same body as the first, nesting never accumulates, and "the innermost
original" is not a case that arises. This holds over a **planned** epic body (the position axis,
#4850) and it holds when the re-run's mode **differs** from the mode that wrote the envelope (the
mode axis, #4866) — the two qualifications the sentence previously needed. The one case it does not
claim is a body carrying no marker and matching neither v1 shape, which is a *first* enrichment by
definition rather than a re-run. The detector itself refuses nothing — it is a body-composition
rule, not a refusal branch, so it adds no row to the exit-status or error tables below. This is the
rule's only statement in this spec; the Scope section below states the scope and does not restate it.

**Redaction is asymmetric and deliberate.** The **preserved original** is foreign content: any
machine-local path in it is masked to its class root, counted, and reported on stderr with its line
number. **Your rewrite** is authored now, so a machine-local path in it is refused on exit `5` — you
can fix what you just wrote. Refusing the original instead would strand the enrichment on somebody
else's leak, and preserving it unredacted re-commits that leak into a public issue.

**The acceptance-criteria block is read back before the write, and the split follows redaction's.**
Per ADR [0288](../../../../.decisions/0288-producers-run-consumer-readers.md) this verb runs the
criteria format's own registered reader
([`packages/fabrika-cli/src/wire/acceptance-criteria.ts`](../../../../packages/fabrika-cli/src/wire/acceptance-criteria.ts))
over the body it has composed and refuses on `15` when the answer is `Malformed`, so a block every
downstream grader would reject never reaches the board. **The grammar is not restated here or in
`SKILL.md`** — the module owns it and the refusal quotes the reader's own reason (ADR 0241).
Two boundaries carry the weight:

- **The read runs over the composed body, not over stdin.** The authored region includes what the
  envelope adds, so a heading the template itself demoted is caught. Reading stdin alone would miss
  exactly the case 0288 §1 names.
- **It stops above the marker**, on the same asymmetry redaction uses: the preserved original is
  foreign content, and a legacy `##` heading buried in it would otherwise refuse every
  re-enrichment of that issue forever.

`Absent` is **not** a refusal. An epic pitch, a decision, a parked ticket may legitimately carry no
criteria block; a verb that demanded one would be a different verb.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — the rewrite, or the pitch with `--epic` |
| `5` | the **authored** text carries a machine-local path — the rewrite, or the pitch with `--epic` |
| `6` | the **authored** text is a bare `@` path reference — the rewrite, or the pitch with `--epic` |
| `7` | the issue is proven absent (404), is closed, or it was read and its body is empty — a read that succeeded over nothing |
| `8` | the `PATCH` failed — UNKNOWN whether the body changed |
| `9` | the body was written but the read-back does not match |
| `11` | the issue body could not be read, so there is no original to preserve — or its comments, or the claim on them, could not be read |
| `17` | a live claim marker on the issue names another session — or, when `--token` named this lane, another lane of this one; a tokenless call is refused once two lanes of its session hold live markers |
| `15` | the composed body's **authored region** carries an acceptance-criteria block the wire reader classifies `Malformed` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage enrich: no body on stdin — pipe the rewritten body in (with --epic, the pitch's five fields).` | 3 | refusal |
| `triage enrich: issue #<n> not found in <repo>.` | 7 | refusal |
| `triage enrich: issue #<n> is already closed.` | 7 | refusal |
| `triage enrich: cannot read #<n>'s comments in <repo>: <reason> — the claim on it is UNKNOWN; nothing was written.` | 11 | refusal |
| `triage enrich: cannot resolve the claim on #<n> in <repo>: <reason> — nothing was written.` | 11 | refusal |
| `triage enrich: #<n> is claimed by session <s> — refusing to mutate another session's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage enrich: #<n> is claimed by lane <l> of this session, not by this lane (<nonce>) — refusing to mutate a sibling lane's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage enrich: #<n> carries live claim markers from more than one lane of this session and this call names none, so which lane is asking is UNKNOWN — pass the `--token` `fabrika triage claim <n>` handed this lane.` | 17 | refusal |
| `triage enrich: #<n> has an empty body — there is no original to preserve, and an empty one must never be preserved as though it were the record.` | 7 | refusal |
| `triage enrich: cannot read #<n> in <repo>: <reason> — refusing to write an envelope over an original that was never read.` | 11 | refusal |
| `triage enrich: the text you sent on stdin carries a machine-local path at line <k> (<class>) — rewrite it repo-relative. The preserved original is redacted automatically; this refusal is about the text you wrote.` | 5 | refusal |
| `triage enrich: stdin is a bare "@" path reference — the text never arrived. Send its bytes, not its path.` | 6 | refusal |
| `triage enrich: redacted <k> machine-local path(s) from the preserved original (lines <l1>, <l2>).` | 0 | notice |
| `triage enrich: PATCH failed: <reason> — UNKNOWN whether the body changed; re-read #<n> before retrying.` | 8 | refusal |
| `triage enrich: body written but the read-back does not match — inspect #<n> before continuing.` | 9 | refusal |
| `triage enrich: the rewrite composes an acceptance-criteria block the wire reader rejects — <reader's reason> (<evidence>). The grammar is owned by packages/fabrika-cli/src/wire/acceptance-criteria.ts; fix the block or drop it.` | 15 | refusal |

**Scope** — one issue body, plus the caller's stdin: the rewrite, or the pitch with `--epic`. An
issue proven absent is `7`; a body that could not be read is `11`; a body that *was* read and is
empty is `7`, a read that succeeded over nothing. None of the three ever degrades to an empty
original preserved as though it were the record — which is the failure that would quietly delete a
report while printing `enriched`. Re-enrichment is covered above, under the detector.

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
$ fabrika triage enrich 4318 --epic < pitch.md
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
- Founder ruling #4866 (2026-08-08), option (b) — the re-enrich detector is a verb-written marker
  rather than envelope-shape inspection, with the issue number bound into it and a self-healing
  legacy migration. It supersedes the two shape-based detectors this section carried, on evidence
  from investigation #4896 (map #4891). The wrap-last unification (option (c)) stays on the table as
  within-brief design for fabrika's `plan-epic` (#4712); if it is adopted later the marker becomes
  redundant insurance, and nothing here has to be undone.
- Founder ruling #3909 / §PITCH — lane-entering work becomes pickable only carrying a pitch, and
  `pitch-guard` scopes **every** triaged `type:epic`. This verb is the group's only body-writing
  verb, so `--epic` reading the pitch on stdin is the epic's one path to that section; an earlier
  revision read no stdin here, which required a section it left no way to write.

---

## `triage apply`

**Invocation**

```
fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47
fabrika triage apply 4312 --type chore --priority p2 --ready-for agent --lane axis:pipeline-hardening
fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47 --token <claim-token>
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to stamp |
| `--type` | enum | yes | — | one of `bug`, `feature`, `chore`, `decision`, `investigation`, `epic` |
| `--priority` | enum | yes | — | one of `p0`, `p1`, `p2` |
| `--ready-for` | enum | yes | — | who picks it up: `human` or `agent` |
| `--home` | integer | one of | — | the **number** of an open milestone to home the issue in |
| `--lane` | enum | one of | — | a standing lane, taking its values from the `lane` rows `triage homes` prints |
| `--token` | string | no | none | the claim token `triage claim` handed this lane; without it the guard reads the session alone and refuses once two lanes of it hold live markers |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Exactly one of `--home` / `--lane` is required.** Supplying both, or neither, is a usage error. This
is the whole design: an un-homed `status:triaged` issue is **unrepresentable** rather than detected
afterwards, so the verb never needs to judge homing — a question already enforced by a CI guard
firing on the very label it applies. Requiring the input is a precondition; recomputing the verdict
would be a second answer to a gated question.

**Every classification value is a closed enum decoded at the boundary**, not a free string checked in
prose. `--priority 1` is refused before any write.

**`--ready-for agent` asserts the acceptance-criteria block, and refuses on `16` before writing any
label.** The live body is read through the same wire module every downstream grader reads
(`packages/fabrika-cli/src/wire/acceptance-criteria.ts`), and anything it does not answer `Found` on
is refused: `ready-for:agent` promises a builder can pick the issue up cold, and the block is what
the promise is made of. The refusal names the reader's own reason and routes by arm — a `Malformed`
block goes to `triage repair-criteria`, an `Absent` one has nothing to repair mechanically and goes
back through `enrich`. Stamping over it instead defers the discovery to `review criteria`, after a
branch, a build, a push, a PR and a CI run are spent (kamp-us/demlik#4 and its burned PR #12;
[#6025](https://github.com/kamp-us/phoenix/issues/6025)).

**`--type epic` is exempt, and the exemption is load-bearing.** A triaged epic carries a `## Pitch`
and gets its criteria later, per child, from the plan ledger — #5979 and #5817 are both
`type:epic status:triaged ready-for:agent` over a body with no block — so a blanket refusal would
make an epic unstampable. `--ready-for human` is unaffected on every type: the promise the block
backs is the one made to an agent.

**Output** — machine channel. One tab-separated line: `triaged`, `<number>`, `<type>`, `<priority>`,
`<ready-for>`, `<home>` — where `<home>` is the milestone number or the lane label. With `--json`, an
object with those keys plus `removed` (the labels superseded) and `readBack`, an object of
`{labels, milestone}` observed after the write.

**`readBack` carries the milestone, not only the labels.** A labels-only read-back cannot evidence a
`--home` at all — the flag's entire effect is a milestone — so it reported success over the one facet
it never looked at.

**The transition is one envelope, and the read-back proves the end state positively.** The verb
re-reads the issue's labels and milestone and asserts the positive shape required — exactly one
`type:`, exactly one `p*`, `status:triaged` present, exactly one `ready-for:`, `status:needs-triage`
absent, and the home: with `--home`, the milestone number equals the flag; **with `--lane`, the
milestone is `null`**. It does **not** assert on the absence of an imagined failure, and it never
reports the requested classification as the landed one.

### The owned facets — what `apply` may remove

Closed input enums fix the *write*. They do not fix the *delete*, and #4285's actual mechanism was a
delete: `p2` was removed because the priority facet owned `/^p\d+$/` and `p2` was not in the keep
set. So the ownership rule is stated here rather than left for an implementer to invent:

| Facet | Owned | Kept |
|---|---|---|
| type | `^type:` | `type:<--type>` |
| priority | `^p\d+$` | `<--priority>` |
| status | `^status:(needs-triage\|triaged\|needs-info)$` | `status:triaged` |
| audience | `^ready-for:` | `ready-for:<--ready-for>` |
| lane | the two lane labels `triage homes` lists | `<--lane>`, or none when `--home` was given |
| **milestone** | the issue's milestone, whatever it is | `--home`'s number, or **none** when `--lane` was given |

**Every label matching an owned pattern and not in the keep set is removed; every label matching no
owned pattern is preserved untouched.** An `area:*`, a `fabrika`, a `wave:*` — none is this verb's
business, and a reconcile that removes what it does not own is a silent data loss.

**The milestone is a facet, and it was missing.** The lane row cleared a lane label when `--home` was
given, but nothing cleared a milestone when `--lane` was given, and the read-back asserted only that
the home was present. That combination lands a state **ADR 0208 explicitly bans**: a milestone on a
`wayfinder:backlog` or `axis:pipeline-hardening` item. The verb could produce a banned state and read
it back as correct. With the facet and the `milestone is null` assertion, `--lane` clears the
milestone and proves it cleared.

**Because `--priority` is a closed enum, the priority facet's owned pattern can never be wider than
what `--priority` can emit** — which is precisely the invariant v1 broke. The generalised rule: for
every facet, the set of values the input can produce must be a subset of what the facet owns. An
implementer adding a facet must re-check that containment.

### The label vocabulary is a precondition, not an assumption

Before any write, the verb asserts that **the labels this invocation will actually write** exist in
the repository: `type:<--type>`, `<--priority>`, `status:triaged`, `ready-for:<--ready-for>`, and,
with `--lane`, the lane label. Five labels, not the whole vocabulary. A missing one **refuses on
`7`** rather than writing.

**This is the narrow reading, deliberately.** A single `apply` writes one type, one priority, one
audience — so checking all six types and all three priorities would refuse a perfectly good
`--type bug` in a repo that merely lacks `type:investigation`, punishing an invocation for a label it
was never going to touch. The refusal message is singular for the same reason: there is exactly one
missing label to name.

This matters because the add-labels endpoint **creates an unknown label rather than rejecting it**.
`POST /repos/{owner}/{repo}/issues/{n}/labels` was measured against the live API on 2026-07-26: it
returns HTTP 200, and the label materialises **repo-wide** at grey `ededed` with a null description.
The measurement is recorded in `claude-plugins/kampus-pipeline/skills/doctor/doctor.sh`. That is the
mechanism behind **#4285** — v1's `apply-triage` not validating `--p`, so a bare `1` is applied as a
literal label and reported as success — as observed on #4282. A closed enum stops a malformed
*input*; only a vocabulary check stops a well-formed input from minting a label in a repo that was
never bootstrapped.

**The endpoint is named because the alternative fails differently.** `gh issue edit --add-label`
rejects an unknown label client-side, so an implementer who reached for it would find this
precondition redundant and drop it — and the verb would start minting labels the moment it moved to
the REST call. (ADR 0059 states the opposite, that the endpoint 422s on an unknown label. The
measurement above is the ground truth used here; the contradiction is filed as #4834.)

(At authoring time `ready-for:human`, `ready-for:agent` and `closed-by-triage` were verified present
in `kamp-us/phoenix` with audience-only descriptions. The check exists for the repo-agnostic case and
for drift, not because they are currently absent.)

**Exit status**

| Code | Trigger |
|---|---|
| `7` | a label this invocation would write does not exist in the repository, or the issue is closed |
| `8` | a label or milestone write failed — UNKNOWN which changes landed |
| `9` | the writes landed but the read-back does not show the required end state |
| `10` | an off-vocabulary enum value, or `--home` names a milestone that is not open |
| `11` | the issue, its comments, the claim on it, the repository's label set, or its milestone set could not be read |
| `17` | a live claim marker on the issue names another session — or, when `--token` named this lane, another lane of this one; a tokenless call is refused once two lanes of its session hold live markers |
| `16` | `--ready-for agent` over a live body the wire reader does not answer `Found` on — every type but `epic`; nothing was written |
| `18` | `.fabrika.jsonc` yielded no usable value — a key's load-time check refused it (the containment invariant is one such check), the file could not be read, or a key did not decode; refused at load, before the issue is even read |

The issue being proven absent is `7` as well — the same zero-scope seat, since there is no issue to
stamp.

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
| `triage apply: issue #<n> not found in <repo>.` | 7 | refusal |
| `triage apply: issue #<n> is already closed.` | 7 | refusal |
| `triage apply: cannot read #<n>'s comments in <repo>: <reason> — the claim on it is UNKNOWN; nothing was written.` | 11 | refusal |
| `triage apply: cannot resolve the claim on #<n> in <repo>: <reason> — nothing was written.` | 11 | refusal |
| `triage apply: #<n> is claimed by session <s> — refusing to mutate another session's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage apply: #<n> is claimed by lane <l> of this session, not by this lane (<nonce>) — refusing to mutate a sibling lane's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage apply: #<n> carries live claim markers from more than one lane of this session and this call names none, so which lane is asking is UNKNOWN — pass the `--token` `fabrika triage claim <n>` handed this lane.` | 17 | refusal |
| `triage apply: .fabrika.jsonc is refused — <reason>. Nothing was written; fix the config, because every label this verb would reconcile is judged against it.` | 18 | refusal |
| `triage apply: cannot read <what> in <repo>: <reason> — nothing was written; the transition is UNKNOWN.` | 11 | refusal |
| `triage apply: write failed after <k> of <m> changes: <reason> — #<n> may be partially labelled; re-run this verb, which is idempotent.` | 8 | refusal |
| `triage apply: read-back shows <observed> — expected exactly one type, one priority, status:triaged, one ready-for, and <the milestone / no milestone>.` | 9 | refusal |
| `triage apply: #<n> carries no acceptance-criteria block — <the reader's reason>. ready-for:agent promises a builder can pick it up cold; an absent block has nothing to repair mechanically, so author one with \`triage enrich\`. Nothing was written.` | 16 | refusal |
| `triage apply: #<n>'s acceptance-criteria block is malformed — <the reader's reason> (<its evidence>). Repair a level drift with \`triage repair-criteria <n>\`; anything else needs a hand. Nothing was written.` | 16 | refusal |

**`milestone <n> is not open` moved off `1` and onto `10`.** Deciding it requires a network read of
the repository's milestone set, so it is a verdict the verb *proved* — and rule 3 is explicit that a
proven verdict must never share a code with a failure to invoke, or `[ $? -ne 0 ]` reads "never ran"
as "ran and proved it". It sits with the other off-vocabulary refusals because a closed milestone is
an off-vocabulary home. `1` is left for the shape error alone. A milestone set that could not be
*read* is `11`, not `10` — unread is not off-vocabulary.

**Order of operations.** The home is settled **before** `status:triaged` is applied — the milestone
assigned with `--home`, or cleared with `--lane`. The homing guard fires on the label event, so
stamping first opens a real window in which the issue is triaged and un-homed (or triaged and
banned-state milestoned) and the guard reds on the happy path — and a guard that reds on correct work
is one people learn to ignore. The verb is idempotent: re-running it converges on the same end state.

**Scope** — one issue's labels and milestone, plus the repository's label set and its open-milestone
set. There is no zero-scope case for the issue itself: it is proven present and read back, or the
verb exits `7`. The vocabulary read is what makes the `7` refusal *proven*, which is why its own
failure is `11` and never a silent pass.

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
{"outcome":"triaged","number":4312,"type":"bug","priority":"p2","readyFor":"agent","home":47,"removed":["status:needs-triage"],"readBack":{"labels":["type:bug","p2","status:triaged","ready-for:agent"],"milestone":47}}
```

```
$ fabrika triage apply 4290 --type chore --priority p2 --ready-for agent --lane axis:pipeline-hardening --json
{"outcome":"triaged","number":4290,"type":"chore","priority":"p2","readyFor":"agent","home":"axis:pipeline-hardening","removed":["status:needs-triage"],"readBack":{"labels":["type:chore","p2","status:triaged","ready-for:agent","axis:pipeline-hardening"],"milestone":null}}
```

**Grounding**

- **#4285** — v1's `apply-triage.sh` passes `--p` through as a free string, and the priority facet
  *owns* only `/^p\d+$/`. Running `--p 1` mints a literal label `1`, supersedes the real `p2` because
  `p2` is owned and not in the keep set, and leaves the issue reading fully triaged **with no
  priority at all** — while the verb prints a success line indistinguishable from a correct run
  (observed on #4282). The closed enums and the positive read-back are that incident, from both ends.
- v1's tracker read-back does `const landed = landedStatus ?? status` — when the read finds no status
  label it **reports the requested one as landed**, and the type and priority labels are never
  verified at all. A read-back that falls back to the request is not a read-back.
- **#4780** — `status:triaged` states readiness, `ready-for:` states audience; a run that emits the
  first without the second is incomplete. Making it a required enum is what makes that structural.
- #4693 — an authoring brief left in the builder's candidate pool is the failure `ready-for:human`
  exists to prevent.
- ADR 0202 / 0208 — home or standing lane, never both, never neither, and **never a milestone on a
  lane item**. The first half is enforced as a required, mutually exclusive input; the second is the
  milestone facet and the `milestone is null` assertion above.
- v1's `--status <stage>` flag is documented in its SKILL.md and **does not exist** in its script,
  which drops every argument past `$3` — so `needs-info`, one of three mandated outcomes, was
  unreachable. That outcome is `triage park` here, a first-class verb.

---

## `triage park`

**Invocation**

```
fabrika triage park 4312 [--token <claim-token>] [--repo <owner/name>] [--json]
```

The questions arrive on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to park |
| `--token` | string | no | none | the claim token `triage claim` handed this lane; without it the guard reads the session alone and refuses once two lanes of it hold live markers |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the questions that would unblock the issue |

**Output** — machine channel. One tab-separated line: `parked`, `<number>`, `<comment-url>`. With
`--json`, an object with keys `outcome`, `number`, `commentUrl`, and `removed` (the labels dropped).

**This is a separate verb rather than `apply --status needs-info`,** because a parked issue carries
no type, no priority, no audience and no home. Folding it into `apply` would make four required flags
conditionally required — the shape that let v1 emit a fully-triaged-looking issue with a facet
missing.

### The owned facets — what `park` may remove

Stating the end state is not enough; a verb that asserts "a parked issue carries no type" and then
reads back only its own two labels will certify an issue that carries five. That gap is reachable
without any misuse: a re-park, or an issue parked after an earlier `apply`, arrives already priced.

| Facet | Owned pattern | Kept |
|---|---|---|
| status | `^status:(needs-triage\|triaged\|needs-info)$` | `status:needs-info` |
| type | `^type:` | none |
| priority | `^p\d+$` | none |
| audience | `^ready-for:` | none |
| lane | `^(wayfinder:backlog\|axis:pipeline-hardening)$` | none |
| milestone | the issue's milestone | none — cleared |

Every label matching an owned pattern is removed unless it is the one kept; every label matching no
owned pattern is preserved untouched. **The read-back asserts the whole shape**, not just the status
swap: `status:needs-info` present, `status:needs-triage` and `status:triaged` both absent, no
`type:`, no `p*`, no `ready-for:`, no lane label, and the milestone null. `removed` in the `--json`
object is exactly the set this reconcile deleted, so the example's `["status:needs-triage"]` is the
ordinary case — an issue arriving straight from the queue with nothing else to clear.

**Parking a triaged issue is a demotion, and it must leave no residue.** An issue reading both
`status:triaged` and `status:needs-info` corrupts the two queue reads every other verb and the sweep
depend on, and the read-back that is supposed to catch that is the thing that would otherwise certify
it.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — a park with no questions is not a park |
| `5` | the questions carry a machine-local path |
| `6` | the questions are a bare `@` path reference — they never arrived |
| `7` | the issue is proven absent (404), is closed, or `status:needs-info` does not exist in the repository |
| `8` | the comment or the label swap failed — UNKNOWN which landed |
| `9` | the writes landed but the read-back does not match |
| `11` | the issue, its comments, the claim on it, or the repository's label set could not be read |
| `17` | a live claim marker on the issue names another session — or, when `--token` named this lane, another lane of this one; a tokenless call is refused once two lanes of its session hold live markers |
| `18` | `.fabrika.jsonc` yielded no usable value — a key's load-time check refused it (the containment invariant is one such check), the file could not be read, or a key did not decode; refused at load, before the comment is posted |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage park: no body on stdin — a parked issue must say what would unblock it: pipe the questions in.` | 3 | refusal |
| `triage park: issue #<n> not found in <repo>.` | 7 | refusal |
| `triage park: issue #<n> is already closed.` | 7 | refusal |
| `triage park: cannot read #<n>'s comments in <repo>: <reason> — the claim on it is UNKNOWN; nothing was written.` | 11 | refusal |
| `triage park: cannot resolve the claim on #<n> in <repo>: <reason> — nothing was written.` | 11 | refusal |
| `triage park: #<n> is claimed by session <s> — refusing to mutate another session's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage park: #<n> is claimed by lane <l> of this session, not by this lane (<nonce>) — refusing to mutate a sibling lane's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage park: #<n> carries live claim markers from more than one lane of this session and this call names none, so which lane is asking is UNKNOWN — pass the `--token` `fabrika triage claim <n>` handed this lane.` | 17 | refusal |
| `triage park: .fabrika.jsonc is refused — <reason>. Nothing was written; fix the config, because every label this verb would reconcile is judged against it.` | 18 | refusal |
| `triage park: the questions text carries a machine-local path at line <k> (<class>) — rewrite it repo-relative.` | 5 | refusal |
| `triage park: the questions text is a bare "@" path reference — the body never arrived. Send it on stdin.` | 6 | refusal |
| `triage park: label status:needs-info does not exist in <repo> — refusing to write, because the API would create it (#4285).` | 7 | refusal |
| `triage park: cannot read <what> in <repo>: <reason> — nothing was written; the park is UNKNOWN.` | 11 | refusal |
| `triage park: the questions comment on #<n> failed: <reason> — nothing was labelled and #<n> is unchanged. Re-run.` | 8 | refusal |
| `triage park: the questions landed but the label swap failed: <reason> — #<n> carries the questions and may be partially labelled; re-run this verb, which is idempotent.` | 8 | refusal |
| `triage park: read-back shows <observed> — expected status:needs-info present and status:needs-triage absent.` | 9 | refusal |

**The two `8` messages are split because the write order makes them different states.** The comment
is written **first**, by design, so a comment failure leaves nothing labelled at all — "may be
partially labelled" would be false, and a caller reading it would go looking for a label swap that
never started. Only the second failure can leave a partial label state.

**Scope** — one issue, plus the repository's label set for the `status:needs-info` precondition. The
read-back is the one specified under the owned facets above; it is not restated here. Parking leaves
the queue deliberately: a parked question must not resurface in every sweep, and it re-enters when
whoever answers swaps the labels back.

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
  statement of what would unblock it. The write order is the guard, and it is also why the two `8`
  messages differ.

---

## `triage kill`

**Invocation**

```
fabrika triage kill 4312 --confirm [--duplicate-of <n>] [--token <claim-token>] [--repo <owner/name>] [--json]
```

The reason arrives on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue to close not-planned |
| `--confirm` | boolean | no | `false` | assert that the confirmation step ADR 0159 requires has been performed — salvage was attempted and this filing is genuinely unsalvageable or moves nothing forward. Its absence is a **refusal on `13`**, not a usage error |
| `--duplicate-of` | integer | no | absent | the surviving issue; this issue's content is folded into it before closing |
| `--token` | string | no | none | the claim token `triage claim` handed this lane; without it the guard reads the session alone and refuses once two lanes of it hold live markers |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the reason this issue is being closed not-planned |

**`--confirm` is optional at the parser and refused at the verb, and that is not a contradiction —
it is the point.** A parser-required flag's absence is a usage error, exit `1`, indistinguishable
from a typo. ADR 0159's confirmation is a *decision*, so its absence must be a proven refusal the
caller can read as one: exit `13`, with a message naming what to do. An earlier revision marked it
`Required: yes` with `Default: false`, which is incoherent and contradicted its own exit table.

**Output** — machine channel. One tab-separated line: `killed`, `<number>`, `<foldedInto>` — where
`<foldedInto>` is the surviving issue number or `none`. With `--json`, an object with keys `outcome`,
`number`, `foldedInto` (number or `null`), `redactions` (count masked from the folded body), and
`provenance` (the value this verb read for itself).

**Two guards, and they are different guards.** ADR 0159 splits the population in two and puts a
distinct protection on each half; a spec that implements one and drops the other has narrowed an
accepted decision.

1. **No agent signal ⇒ human-owned ⇒ PROTECTED.** The verb runs the `triage provenance` predicate
   itself rather than trusting the caller to have run it — the anchored footer match **and** the
   operator-account test, both from the one definition. A `human` answer — no footer *and* an author
   outside `$FABRIKA_OPERATOR_ACCOUNTS`, including the fail-closed default on an **empty** body —
   refuses on exit `12`. When the operator set is unconfigured the refusal carries a stderr notice
   saying so, because otherwise "the config is empty" and "this really is a human filing" produce an
   identical refusal. An **unreadable** body is exit `11`, not a `human` verdict: the kill is refused
   either way, but a caller must never be told the issue was measured as human-filed when nothing was
   measured. **`--duplicate-of` is the one exception, and it is conditional rather than merely
   later** ([#6070's ruling](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454),
   recorded as ADR 0181's 2026-08-21 amendment): a fold moves the content into an open survivor
   instead of discarding it, so the protection it exists to give — the report survives somewhere a
   human will read it — is already discharged. Gating on the flag rather than reordering the test is
   what keeps `12` ahead of `13` on the non-fold path; a human filing with neither flag still refuses
   on `12`, and one with `--duplicate-of` and no `--confirm` still refuses on `13`.
2. **An agent signal ⇒ eligible *after confirmation*, and "the confirmation step IS the guard."**
   A human-invoked `/report` also emits the footer, so footer presence alone is **not** licence to
   close — ADR 0159 reserves a confirmation-free close-sweep as an explicitly re-opened question.
   `--confirm` is that step made structural: without it the verb refuses on exit `13`, so an
   autonomous sweep cannot close on footer presence alone, and the flag is a greppable, auditable act
   rather than a thing the model was supposed to remember.

**The duplicate fold is redacted.** With `--duplicate-of`, this issue's body is posted as a comment on
the surviving issue **through the same redaction `triage enrich` applies**, before this issue is
closed. v1 redacted the enrich path and left this one raw — the same body, copied into a new public
location, with the leak matcher literally named for comments.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — an unauditable kill |
| `5` | the reason text carries a machine-local path |
| `6` | the reason is a bare `@` path reference — it never arrived |
| `7` | the issue is proven absent or already closed; `--duplicate-of` is proven absent or closed; or `closed-by-triage` does not exist in the repository |
| `8` | one of the four writes failed — the message names what did and did not land |
| `9` | the writes landed but the read-back does not show a not-planned close |
| `11` | the issue body, its comments, the claim on it, the duplicate, or the label set could not be read — no kill was attempted |
| `17` | a live claim marker on the issue names another session — or, when `--token` named this lane, another lane of this one; a tokenless call is refused once two lanes of its session hold live markers |
| `12` | refused: the issue is human-filed — no agent footer and no operator author — and no `--duplicate-of` was named (the fold exception, above) |
| `13` | refused: close-eligible, but `--confirm` was absent (ADR 0159) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `triage kill: no body on stdin — refusing an unauditable kill: pipe the reason in.` | 3 | refusal |
| `triage kill: issue #<n> not found in <repo>.` | 7 | refusal |
| `triage kill: issue #<n> is already closed.` | 7 | refusal |
| `triage kill: --duplicate-of #<m> is closed — refusing to fold this issue's content into a closed issue where nobody will read it.` | 7 | refusal |
| `triage kill: the reason carries a machine-local path at line <k> (<class>) — rewrite it repo-relative.` | 5 | refusal |
| `triage kill: the reason is a bare "@" path reference — the body never arrived. Send it on stdin.` | 6 | refusal |
| `triage kill: label closed-by-triage does not exist in <repo> — refusing a kill that would be invisible to the audit.` | 7 | refusal |
| `triage kill: cannot read #<n> in <repo>: <reason> — the provenance test has no evidence; refusing to close on a body that was never read.` | 11 | refusal |
| `triage kill: cannot read #<n>'s comments in <repo>: <reason> — the claim on it is UNKNOWN; nothing was written.` | 11 | refusal |
| `triage kill: cannot resolve the claim on #<n> in <repo>: <reason> — nothing was written.` | 11 | refusal |
| `triage kill: #<n> is claimed by session <s> — refusing to mutate another session's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage kill: #<n> is claimed by lane <l> of this session, not by this lane (<nonce>) — refusing to mutate a sibling lane's issue. Run `fabrika triage claim <n>` and act only on `won`.` | 17 | refusal |
| `triage kill: #<n> carries live claim markers from more than one lane of this session and this call names none, so which lane is asking is UNKNOWN — pass the `--token` `fabrika triage claim <n>` handed this lane.` | 17 | refusal |
| `triage kill: #<n> is human-filed — refusing to close it. Park it with questions instead.` | 12 | refusal |
| `triage kill: #<n> is agent-filed and close-eligible, but ADR 0159 makes the confirmation the guard — pass --confirm once salvage has genuinely been attempted.` | 13 | refusal |
| `triage kill: #<n> is human-filed and would be folded into #<m>, but ADR 0159 makes the confirmation the guard — pass --confirm once salvage has genuinely been attempted.` | 13 | refusal |
| `triage kill: the fold comment on #<m> failed: <reason> — #<n> is NOT closed, carries no reason and no label; nothing was lost. Re-run.` | 8 | refusal |
| `triage kill: the reason comment on #<n> failed: <reason> — #<n> is NOT closed and carries no label, but the fold on #<m> DID land; delete that comment before re-running, or the fold posts twice.` | 8 | refusal |
| `triage kill: applying closed-by-triage to #<n> failed: <reason> — the fold and the reason comment landed; #<n> is still OPEN and invisible to the kill audit. Apply the label by hand, or delete the landed comments and re-run.` | 8 | refusal |
| `triage kill: closing #<n> failed: <reason> — the fold, the reason and closed-by-triage all landed; #<n> is still OPEN and fully annotated. Close it by hand with state_reason=not_planned, or delete the landed comments and re-run.` | 8 | refusal |
| `triage kill: closed, but the read-back shows state_reason=<observed>, not not_planned — #<n> reads as done rather than killed.` | 9 | refusal |
| `triage kill: no operator accounts are configured (FABRIKA_OPERATOR_ACCOUNTS is unset), so a footerless filing reads human whoever authored it.` | 12 | notice |
| `triage kill: redacted <k> machine-local path(s) from the folded duplicate body.` | 0 | notice |

**Write order is the auditability guarantee.** Fold the duplicate content, post the reason comment,
apply `closed-by-triage`, then close with `state_reason=not_planned` — and **each step gates the
next**. v1 ran three unguarded sequential writes under `set -uo pipefail` with no `-e`, so a failed
reason comment did not stop the close: the issue landed closed, unexplained, and invisible to the
kill audit. Here a failure before the close leaves the issue **open**, which is the recoverable
direction.

**All four steps therefore carry their own `8` message**, each naming what landed, what did not, and
the recovery — because the shared conventions promise every `8` message carries one, and a single
generic "a write failed" would leave a caller unable to tell "nothing happened, re-run" from "three
comments are live, re-running duplicates them". An earlier revision covered only the fold. The
read-back asserts `state` is `closed` **and** `state_reason` is `not_planned`, because a plain
`closed` reads as "done", not "killed".

**`closed-by-triage` is provenance, and the refusal on its absence stands for a different reason
(ADR [0256](https://github.com/kamp-us/phoenix/blob/main/.decisions/0256-kill-audit-keys-on-the-not-planned-close.md)).**
The kill audit's key is the not-planned close itself, so the label no longer carries coverage — it
records that **triage** was the actor. The exit-`7` refusal on the label's absence is therefore
**unchanged in behaviour and changed in rationale**: the kill would not be *invisible* (the close is
the key), it would be **unattributable** — a triage kill that cannot carry its stamp is
indistinguishable from a founder-session close, which is the confusion the label exists to prevent.
Two consequences bind this verb. It gains **no** actor flag and **no** courtesy stamp: a non-triage
actor's kill does not run this verb and must not carry the label, and it stays auditable through the
close plus its reason comment. And the two shipped strings above that still read *"invisible to the
audit"* (the exit-`7` refusal and the exit-`8` label-write failure) are reworded when the v1 audit
query is re-keyed and paginated ([#4928](https://github.com/kamp-us/phoenix/issues/4928)) — the codes
and the write order do not move.

**Scope** — one issue with its body and author login, the repository's label set, plus the surviving
issue when `--duplicate-of` is given.

**Examples**

```
$ fabrika triage kill 4312 --confirm --duplicate-of 4290 < reason.md
killed	4312	4290
```

```
$ fabrika triage kill 4290 --confirm < reason.md
triage kill: #4290 is human-filed — refusing to close it. Park it with questions instead.
$ echo $?
12
```

```
$ fabrika triage kill 4312 < reason.md
triage kill: #4312 is agent-filed and close-eligible, but ADR 0159 makes the confirmation the guard — pass --confirm once salvage has genuinely been attempted.
$ echo $?
13
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
  and computed it nowhere. The #4619 ruling narrows *who counts as human-filed*, not the protection:
  a footerless filing from a non-operator is as protected as it ever was. The #6070 ruling narrows
  the protection itself, on one path only — a `--duplicate-of` fold, which preserves the content in
  an open survivor rather than discarding it.
- v1 `audit-kills.sh` — the compensating control for the whole kill path — reads one unpaginated
  page, so it goes blind past 30 kills with no truncation signal, and it keys on the label, so it
  cannot see a kill any other actor executed (ADR
  [0256](https://github.com/kamp-us/phoenix/blob/main/.decisions/0256-kill-audit-keys-on-the-not-planned-close.md)
  re-keys it onto the close). This spec does not re-mint that verb; the audit belongs to a board
  surface, and the fail-closed write order above is what makes a kill auditable at the moment it
  happens.

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
`none` and `indeterminate` all still exit 0, and the existing `1` / `7` / `27` / `28` are untouched.

**`dedup`'s codes come from the `report` table, not this group's.** `7` is a missing `--label`, and
`27`/`28` are the queue and the search index read failing — numbers no `triage` verb speaks, so a
caller invoking both in one sweep never has to ask which table a code came from.

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
