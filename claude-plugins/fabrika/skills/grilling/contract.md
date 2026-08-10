# `/grilling` — derived CLI contract

**Skill:** [`grilling`](SKILL.md) · **Authoring brief:** [#5019](https://github.com/kamp-us/phoenix/issues/5019) · **Date:** 2026-08-09

**Where these verbs land.** `packages/fabrika-cli/`, under a **`grill`** subcommand group registered
in [`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts). Each leaf is built with
`leafCommand` from [`src/excess-operand.ts`](../../../../packages/fabrika-cli/src/excess-operand.ts)
so an undeclared operand is refused rather than ignored. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill.** No verb here invokes
anything under `claude-plugins/kampus-pipeline/` or `packages/pipeline-cli/`, in a fence, behind a
wrapper, or as a contract clause (ADR
[0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every v1 module
named in a **Grounding** block below is cited as a **scar to design out**, never as a dependency —
those citations are non-normative and an implementer opens none of them to build this.

**The group name.** `grill`, free against
[`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts) when this was written; the
registered groups were `adr build epic eval hook ledger plan report review review-ui ship spend
triage ui wire`, though that list grows most weeks, so read the file rather than this sentence. `grill` is the
verb group; `grilling` is the skill.

**What fabrika already ships, reused — never respecified.** Each is imported, not restated, because
a transcription drifts and a pointer to code cannot:

- [`src/build/claim.ts`](../../../../packages/fabrika-cli/src/build/claim.ts) `resolveOwnership` —
  per-comment-author permission resolution, memoized, over `AUTHORIZED = {admin, maintain, write}`.
  Its stated invariant is the one this group's authority story rests on: *a permission read that
  fails is UNKNOWN, never a demotion.*
- [`src/io/pulls.ts`](../../../../packages/fabrika-cli/src/io/pulls.ts) `permissionFor`,
  `viewerLogin`.
- [`src/io/issues.ts`](../../../../packages/fabrika-cli/src/io/issues.ts) `getIssue`,
  `listComments`, `createComment`, `addLabels`.
- [`src/report/leaks.ts`](../../../../packages/fabrika-cli/src/report/leaks.ts) `scanBody`,
  `isBareAtReference`, `renderLeaks`.
- [`src/report/compose.ts`](../../../../packages/fabrika-cli/src/report/compose.ts)
  `normalizeForReadback` — read-backs compare normalized, never byte-identical.
- [`src/verb.ts`](../../../../packages/fabrika-cli/src/verb.ts) `answer` / `refuse`, and the `emit`
  adapter each group copies.
- [`src/wire/verdict-marker.ts`](../../../../packages/fabrika-cli/src/wire/verdict-marker.ts) — its
  **shape** is the model for the three markers below: a total read returning `Found | Absent |
  Malformed`, and a separately three-valued binding check. The format itself is **not** reused and
  its `NAMESPACE` is **not** widened; see *Why new formats rather than widening* below.

**Considered and deliberately not derived.**

- **A `grill status` verb.** Its only behaviour would be relaying a summary `grill read` already
  computes — a wrapper whose sole job is relaying an upstream answer, which ADR 0238 forbids. `grill
  read` returns the per-question rows **and** the counts in one object instead.
- **A verb that decides whether a question is a fact or a decision.** That is the judgment the
  wrapper exists to carry (`SKILL.md` §2); a verb guessing it would be a stochastic answer wearing a
  deterministic exit code.
- **A verb that edits or retracts a recorded ruling in place.** Retraction is a new round re-asking
  the question, declared with `grill round --supersedes`. An edit verb would let a wrong answer be
  quietly overwritten, which #4227 forbids; superseding leaves both the old question and its
  replacement on the record.
- **A merge-gating verdict.** `grilling` is deliberately absent from `SHIP_NAMESPACES`
  ([`src/review/classes.ts`](../../../../packages/fabrika-cli/src/review/classes.ts)), so no ruling
  recorded here can block a merge. Widening that set would create the second human gate #4631 rules
  out, and would change what every pull request's conjunction requires.
- **A second answer to control-plane membership, pitch approval, or triage classification.** Each is
  already enforced at its own gate. This group states expectations and computes none of them.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `grill open` | open, or resume, the session issue for a topic | a labelled search under a stated normalization plus at most one create; the *topic* is the caller's judgment, the resume-versus-mint decision is a total function of the search result |
| `grill round` | validate a round against the grammar, post it, return its round number, digest and ids | grammar validation, round numbering and the digest are total functions of the stdin bytes and the session's existing rounds; what to ask is the skill's |
| `grill answer` | record an agent-established answer to a `fact` question | a bound comment write behind a kind guard; the finding's content is judgment, its binding is mechanical |
| `grill rule` | record a founder ruling, refusing without verbatim dated authorization | the four-clause check is total; whether he actually said it is not this verb's to know, which is why the authorization is required rather than inferred |
| `grill read` | the parser — per-question state, ACL-resolved, digest-checked, plus the frontier token and every disregarded marker | parse, resolve, compare; the whole state is checkable by construction |

## The round grammar this group WRITES

`grill round` reads one round from stdin. A round is one or more question blocks, and nothing else:

```markdown
### 1 · decision
Do vouched-in yazars inherit their kefil's moderation weight?

**Recommended:** No — weight is earned per account, so a compromised kefil cannot mint authority.

**Trade-offs:** Slower trust accrual for genuinely vouched newcomers; simpler abuse story.
```

- The heading is `### <n> · <kind>`, where `<n>` is the question's 1-based, contiguous position
  **within this round** and `kind` ∈ `fact | decision`. **The caller never writes the round
  number** — the verb derives it (see `grill round`) and stamps the full `R<round>.<n>` id into the
  posted comment. A caller that had to supply the round number would have to guess which round it
  is on, and every guess after round one is a collision.
- `**Recommended:**` is **required on every question**, both kinds. A question without one is a
  bare question list, which the founder's ruled shape excludes.
- `**Trade-offs:**` is required on `decision` questions and optional on `fact` ones.
- Any other `###` heading, a duplicate `<n>`, a gap in the numbering, a `kind` outside the set, or a
  missing required field is `4`.

**Why the recommendation is required rather than banned.** v1 banned it
(`claude-plugins/kampus-pipeline/skills/wayfinder/SKILL.md:386` — *"does not pre-pick a default,
phrase a recommendation as the decision"*). The founder's ruling on
[#5017](https://github.com/kamp-us/phoenix/issues/5017#issuecomment-5229701965) requires one per
question. Those conflict only while the recommendation and the ruling share a surface. Here they do
not: a recommendation is agent-authored body text inside a question block and is never authority; a
ruling is a marker in its own comment resolved against the ACL and an adjacent authorization. The
grammar keeps them apart, which is what makes the founder's shape safe rather than a reversal of
v1's guard.

## The three markers

All three are **new `wire` formats** — `grill-ruling`, `grill-answer` and `grill-supersede` — each
landing as a sibling schema module plus one row in
[`src/wire/registry.ts`](../../../../packages/fabrika-cli/src/wire/registry.ts) `registeredFormats`
— the sanctioned extension seam, never a branch inside a verb.

**`grill-ruling`** — first line of its own comment:

```
grill-ruled: R2.3 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z
```

**`grill-answer`** — first line of its own comment:

```
grill-answered: R2.1 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z
```

**`grill-supersede`** — first line of its own comment, one line per retired question:

```
grill-superseded: R1.4 @ 7c1d4a9b2e60 · round 2 · 2026-08-09T18:36:48Z
```

It carries a fourth field the other two do not: `round <n>`, the round that retired the question.
`grill read` resolves `state: "superseded"` and `supersededBy` from this marker and from nothing
else — **never from the round comment's prose**, which the skill forbids reading state off
(`SKILL.md`, `NEVER-INFER-STATE`). A supersession with no marker is not a supersession.

**Its digest is the RETIRED question's round**, captured at retirement — not the retiring round's.
The marker's job is to record *which text was retired*, so binding the round being written would
record nothing about the thing removed. `grill round` already reads every comment to derive the next
round number, so it can digest the retired round; a round it cannot digest is `14`.

**Which comment it lives in: its own, posted after the round comment.** `grill round --supersedes`
therefore writes **two** comments — the round, then one supersede-marker comment carrying one line
per retired id. Order is load-bearing in the opposite direction from `grill rule`: the round is
written **first**, so an interrupted run leaves the replacement question posted and the old one still
holding the frontier. That is the conservative half — a question that should have been retired and
was not is a nuisance, while a question retired with no replacement posted is a silently dropped
decision.

| Field | Shape |
|---|---|
| question id | `R<round>.<n>` — `R`, the round number, a dot, the question's position |
| digest | exactly 12 lowercase hex characters — the round digest defined below |
| timestamp | ISO-8601 UTC, `Z`-suffixed |

Three formats rather than one discriminated by a field, because they carry different authority and a
reader must never have to parse a field to learn which. `grill-answered` is the agent's own record
and is never a ruling; `grill-ruled` is the only marker `grill read` may resolve to `ruled`;
`grill-superseded` asserts no answer at all, only that a question was retired.

**Read is total and three-valued** for all three, on the `verdict-marker` model: `Found` (all fields
parse), `Malformed` (the key is present and a field does not parse), `Absent` (no such key).
**A malformed marker is never silently `Absent`** — that is the scar this epic's own approval marker
carries, where a real approval whose shape the guard could not see had to be re-stamped months
later. `grill read` reports every malformed marker as a `disregarded` row at exit `0` (see that
verb), so an approval that is real but mis-shaped is a *visible* state rather than an invisible one.

**Why new formats rather than widening `verdict-marker`'s `NAMESPACE`.** That regex
([`src/wire/verdict-marker.ts:73`](../../../../packages/fabrika-cli/src/wire/verdict-marker.ts)) is
guarded by a **prefix gate that runs before the regex is ever tested** (`:78`), and a non-member
returns `Absent` rather than `Malformed` — so a widening that missed either constant would emit
markers it can never read back, which that file's own docblock names as the hazard. A ruling is also
not a verdict: it carries no `PASS`/`FAIL` polarity and binds a round digest rather than a head SHA,
so it would be a third polarity in a two-member set.

<!-- anchor: WIRE-FORMAT-COST --> **What a new wire format actually costs, stated in full because a
short version of this list was wrong in an earlier draft.** Each of the three formats needs, and CI
reds without:

1. a sibling schema module beside the shipped formats;
2. one row in `src/wire/registry.ts` `registeredFormats`;
3. a **rendered projection row plus its own `### <format>` prose section in**
   [`claude-plugins/fabrika/docs/wire-formats.md`](../../docs/wire-formats.md) — `src/wire/index-doc.unit.test.ts`
   asserts the committed doc reconciles against `registeredFormats` with zero findings, that the
   documented key set **equals** the registry's, and that the doc contains `renderProjection(registeredFormats)`
   verbatim;
4. the payload `WireFormat` (`src/wire/format.ts`) makes **required**: a `roundTrip` fixture pair,
   an `absent` sample, a **non-empty** `malformed[]` array with a `drift` label per entry, and a
   non-empty `brandWitnesses` set.

**Stated, not yet enforced.** All of the above lands with the implementation
([#5023](https://github.com/kamp-us/phoenix/issues/5023)). Until it does, nothing in the shipped
package recognizes any of the three keys, and no claim on this page describes present behaviour.

## The round digest, and its neutrality invariant

The digest is the first 12 characters of the lowercase hex SHA-256 of the round's **question text
only** — for each question in id order, its id, its kind, its question prose, its `**Recommended:**`
value and its `**Trade-offs:**` value, joined by `\n`, LF-normalized, with trailing whitespace
stripped per line.

<!-- anchor: DIGEST-NEUTRALITY --> **Named invariant — the digest is neutral to every write it
guards.** It covers no ruling, no answer, no comment posted after the round, and no field any verb
in this group mutates. It must be, because the digest binds rulings and rulings are exactly what
gets written afterwards: a digest covering them would be invalidated by the very operation it exists
to protect, and every clean binding would then attest a round no check ever ran over. **The supersession record is a NEW comment of its own, never an edit to the superseded round's.**
No verb edits an existing comment, and that is what keeps this invariant true: an implementer who
marked retirement by editing round *x*'s comment would change text the digest covers, breaking every
ruling bound to round *x* and flipping its surviving questions to `stale`. Stated explicitly because
neutrality here rests on a prohibition specified elsewhere rather than on anything local.

The implementation owes a deterministic test that recomputing a round's digest yields the
byte-identical value it yielded at `grill round` — after `grill answer`, after `grill rule`, **and
after a later round supersedes one of its questions**, which is the newest write and the one with a
plausible failure mode.

**What the digest buys.** A ruling names the round text it answered. Re-word the question and the
recomputed digest differs, so `grill read` reports that question `stale` — **un-ruled again**. This
is the analogue of `pitch-guard` binding an approval's appetite to the body's Appetite field: a
ruling is bound to *what it ruled*, not to a string that happens to sit nearby. It is also the
retraction path, since a new round re-asking a question is what visibly supersedes its old answer.

## Shared conventions

Every `grill` verb obeys these; stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else. Scope lines,
  refusal reasons and progress go to stderr. **A non-zero exit prints nothing on stdout** — the
  shipped `refuse` helper hardcodes empty stdout, so a partial answer beside a failure code is not
  constructible here and must not be specified.
- **A proven outcome is a state word at exit `0`, never a non-zero code.** `grill read`'s frontier
  token is the worked case: `awaiting-founder`, `facts-pending`, `clear` and `empty` are four
  answers and **all four exit `0`**. A frontier holding open questions is this skill working, not a
  failure, and seating it on a non-zero code would make a caller's `[ $? -ne 0 ]` read "the founder
  has not answered yet" as "the verb never ran".
- **A 404 is a verdict; anything else is UNKNOWN.** A missing issue is `7`. An unreachable or
  erroring GitHub is `11` before any write and `8` after one.
- **Common inputs.** `--repo <owner/name>` (default: resolved from the `origin` remote) on every
  verb. There is no `--json` flag: the answer channel is already one JSON object.
- **GitHub access follows [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)**,
  paginated. The reason lives there. Local to this group: a session with more than one page of
  comments is ordinary after a few rounds, so an unpaginated comment read would report a ruled
  question as open — the fail-open direction.
- **Every text this group sends to GitHub is leak-scanned** with `src/report/leaks.ts` before the
  write — comment bodies **and** the issue title `grill open` composes from `--topic`. A
  machine-local path is `5`, a bare `@` reference is `6`. Every writing verb guards this
  identically; a sibling that wrote unscanned text would be the whole guard's hole. **Widening
  stated:** the base's `5` reads *"…and `--redact` was not given"*; no `grill` verb offers
  `--redact`, so here `5` fires on any machine-local path unconditionally. The condition narrows;
  the meaning does not drift.
- **Every write is read back** and compared with `normalizeForReadback`; a mismatch is `9`.
- **Error messages are prefixed with the invoked verb's name** — `grill rule: …`.
- **A non-zero exit is UNKNOWN to the caller until the code is read.**

### The shared exit matrix

This table owns `code → meaning`. Per-verb **Errors** tables below own only that verb's own
triggers. `0`, `1`, `2` and `127` are stated **here and only here**, and every verb can return them.

| Code | Meaning | `open` | `round` | `answer` | `rule` | `read` |
|---|---|---|---|---|---|---|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ |
| `2` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | `EMPTY_STDIN` — stdin was read and held nothing | — | ✓ | — | — | — |
| `4` | `BAD_SECTIONS` — a required section is missing, out of order, or empty | — | ✓ | ✓ | — | — |
| `5` | `LEAKED_PATH` — the text carries a machine-local path | ✓ | ✓ | ✓ | ✓ | — |
| `6` | `BARE_AT_PATH` — the text is a bare `@` path reference | ✓ | ✓ | ✓ | ✓ | — |
| `7` | `NO_TARGET` — the session issue or the label does not exist | ✓ | ✓ | ✓ | ✓ | ✓ |
| `8` | `WRITE_UNKNOWN` — the write failed, so the outcome is UNKNOWN | ✓ | ✓ | ✓ | ✓ | — |
| `9` | `READBACK_MISMATCH` — the write landed, the read-back differs | ✓ | ✓ | ✓ | ✓ | — |
| `10` | `DELIBERATE_GAP` — held empty, see below | — | — | — | — | — |
| `11` | `PRECONDITION_UNKNOWN` — a precondition read failed; nothing written | ✓ | ✓ | ✓ | ✓ | ✓ |
| `12` | `TOKEN_UNAUTHORIZED` — the **invoking token** is proven below `write+` | — | — | — | ✓ | — |
| `13` | `QUESTION_UNKNOWN` — the id names no question in the session | — | ✓ | ✓ | ✓ | — |
| `14` | `DIGEST_UNBINDABLE` — the round holding the question could not be digested | — | ✓ | — | ✓ | — |
| `15` | `AUTHORIZATION_ABSENT` — `--authorization` missing, empty, or undated | — | — | — | ✓ | — |
| `16` | `SESSION_AMBIGUOUS` — more than one open session matches the topic | ✓ | — | — | — | — |
| `17` | `KIND_MISMATCH` — the question's kind does not admit this verb | — | — | ✓ | ✓ | — |
| `18` | `QUESTION_RETIRED` — the target question was superseded by a later round | — | ✓ | ✓ | ✓ | — |

**`3`–`11` are imported from
[`src/report/codes.ts`](../../../../packages/fabrika-cli/src/report/codes.ts)**, not restated as
numerals, so a drift is unrepresentable rather than merely detectable. `12`–`18` are the group's own
and clear the base's occupied seats; they carry **no** cross-group uniqueness obligation, so
`review`'s `12` and this group's `12` are two namespaces rather than a collision.

**`10` is a deliberate gap**, seated as `DELIBERATE_GAP = REPORT_CLASSIFIED` on the shipped `ui`
precedent (`src/ui/codes.ts`), which `exit-code-alignment.ts` excludes from `allocatedCodes` so the
hold is neither a drift nor a collision. The base's `10` fires when a **title or label** carries a
type or priority classification. No `grill` verb accepts a label flag, none writes a `type:` or
priority label, and `grill open` composes its title from `--topic` without ever classifying it — the
verb runs no such check at all, on either the title or the label path, so the condition is
unreachable rather than merely unused.

#### Terminal seating — which code lands on which §TERM terminal

The closed set of terminal names is the skill's ([`SKILL.md`](SKILL.md) §TERM); the seating is this
matrix's, because it is a total function of the code above and belongs with the codes rather than
restated beside them. Every **non-zero** code seats on exactly one terminal.

| Terminal | Codes | What it means for the run |
|---|---|---|
| `SESSION-OPENED` | `0` from `grill open`, or `grill read` reporting `empty` | the session exists and holds no questions; the next act is a round |
| `ROUND-POSTED` | `0` from `grill round` | its decision questions await him |
| `FACT-ANSWERED` | `0` from `grill answer` | the decision frontier is unchanged |
| `RULING-RECORDED` | `0` from `grill rule` | report it as `ruled` and as no more than that |
| `AWAITING-FOUNDER` | `0` from `grill read`, frontier `awaiting-founder` | at least one decision question is `open`, `unattested` or `stale`, and the run stops |
| `FACTS-PENDING` | `0` from `grill read`, frontier `facts-pending` | nothing awaits him, but the caller's own fact work is unfinished |
| `FRONTIER-CLEAR` | `0` from `grill read`, frontier `clear` | every decision question reads `ruled`; the trail is ready for `graduate` |
| `INPUT-REFUSED` | `3`, `4`, `5`, `6` | an input the caller supplied is **proven** malformed — the round, the finding, the authorization, or the `--topic` — and nothing was written. Fix and re-run; this is not UNKNOWN |
| `SESSION-UNRESOLVED` | `7`, `16` | the session could not be named — absent, unlabelled, or ambiguous. Nothing was written |
| `RECORD-REFUSED` | `12`, `13`, `14`, `15`, `17`, `18` | a writing verb refused on a clause. Nothing was recorded and every question stays exactly as it was — the seam working, not an error to route around |
| `WRITE-UNPROVEN` | `8`, `9` | a write may or may not have landed. Re-read before re-writing |
| `STOPPED` | `1`, `2`, `11`, `127` | the run is UNKNOWN with nothing written |

`10` is the deliberate gap above: unreachable, so it seats on no terminal by design. `0` is
disambiguated by which verb produced it and, for `grill read`, by the `frontier` token — which is
why four of the seven zero-exit rows above name a token rather than a verb alone.

<!-- anchor: KIND-MISMATCH-IS-NOT-GRAMMAR --> **Why a kind mismatch is `17` and not `4`.** Answering
a decision question, or ruling a fact question, is not a defect in the *input document* — the finding
or authorization may be perfectly well-formed. `4` is imported from the base as *a required section
is missing, out of order, or empty*, and overloading an imported constant with a second meaning is
exactly the drift the import exists to stop.

**Registration burden the implementer inherits — four distinct edits, none implied by the others.**

1. `src/registry.ts` — add `grillCommand` to `registeredGroups`.
2. `src/exit-code-alignment.ts` — add `grill` to `ALIGNED_GROUPS`. Its value is a `SharedSeats` map
   keyed by **this group's own export names**, and **none of the four shipped maps fits**: they key
   on `ZERO_SCOPE` and `OFF_VOCABULARY`, while `grill` names `7` `NO_TARGET` and holds `10` as
   `DELIBERATE_GAP` so it cannot claim `OFF_VOCABULARY` at all. A new `GRILL_SEATS` constant is
   authored in that same file.
3. `src/exit-code-alignment.unit.test.ts` — add a `grill` row to the hand-written `TABLES` map, or
   the on-disk-versus-registered coverage assertion reds the moment `src/grill/codes.ts` exists.
4. The **three** wire formats, each with the full four-part cost above — including its own
   `wire-formats.md` section, without which `src/wire/index-doc.unit.test.ts` reds.

---

## `grill open`

**Invocation**

```
fabrika grill open --topic "sozluk moderation model" [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--topic` | string | yes | — | the subject of the session; becomes the issue title and is matched against open `grilling:session` titles to resume rather than mint a duplicate |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the session lives in |

**Behaviour.** Searches open issues carrying `grilling:session`. On exactly one match it resumes
that issue and writes nothing. On no match it creates the issue titled `--topic` verbatim **and
applies the `grilling:session` label to it** — the label is what makes the session findable, so a
created-but-unlabelled issue is the state this verb exists to prevent, and the label write is part
of the create rather than a caller's follow-up.

**Topic matching is exact under a stated normalization**, never fuzzy: both sides are compared after
Unicode NFC normalization, case folding, trimming, and collapsing every internal whitespace run to a
single space. Nothing else — no stemming, no substring, no edit distance. A fuzzy predicate would be
judgment living inside a verb, and it would make `16` fire on titles a human reads as unrelated.

**Output** — machine. One JSON object; every key below is always present:

```json
{"session":9412,"topic":"sozluk moderation model","created":false,"url":"https://github.com/kamp-us/phoenix/issues/9412"}
```

| Key | Type | Meaning |
|---|---|---|
| `session` | integer | the issue number, minted or resumed |
| `topic` | string | `--topic` verbatim, as given |
| `created` | boolean | `true` when this call minted the issue, `false` when it resumed one |
| `url` | string | the issue's HTML URL |

`created` distinguishes a resume from a mint on both paths, so a caller never infers it from an
absence.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `grill open: --topic carries a machine-local path: <path> — refusing to open a session titled with it.` | 5 | refusal |
| `grill open: --topic is a bare @ path reference — not redactable, refusing to open a session titled with it.` | 6 | refusal |
| `grill open: label "grilling:session" does not exist in <repo> — refusing to open a session no later run can find. Create it, or run the front-door bootstrap (#4952).` | 7 | refusal |
| `grill open: the create failed, so whether a session issue exists is UNKNOWN — check <repo> before re-running.` | 8 | refusal |
| `grill open: created #<n> but the read-back does not match what was sent.` | 9 | refusal |
| `grill open: the label write on #<n> failed, so the session may exist unlabelled and unfindable — check #<n> before re-running.` | 8 | refusal |
| `grill open: cannot search <repo> for open sessions: <reason> — whether a session already exists is UNKNOWN, never "none". Re-run; do not mint a second one.` | 11 | refusal |
| `grill open: <n> open sessions match topic "<topic>": #<a>, #<b> — refusing to guess which one is live.` | 16 | refusal |

**Scope** — every **open** issue in `--repo` carrying `grilling:session`, paginated. Zero matches is
a **fact**, not a failed read: no session existing is the ordinary first-run state, and the verb
mints one. A search that could not complete is `11` and mints nothing, because a caller that reads a
failed search as "none" opens a second session and splits the record.

**Examples**

```
$ fabrika grill open --topic "sozluk moderation model"
{"session":9412,"topic":"sozluk moderation model","created":true,"url":"https://github.com/kamp-us/phoenix/issues/9412"}
```

```
$ fabrika grill open --topic "sozluk moderation model"
grill open: 2 open sessions match topic "sozluk moderation model": #9412, #9431 — refusing to guess which one is live.
$ echo $?
16
```

**Grounding**

- ADR 0092 — a search that could not complete never answers "none".
- v1's `create-map.sh:24` prints its refusal prose on **stdout**, the same stream as the issue
  number, so a caller capturing `$(…)` without a status check binds a sentence and then interpolates
  it into `#$MAP`. Here every refusal is stderr-only and stdout is empty on any non-zero exit.
- v1's `create-map.sh:30` collapses auth, 404, rate-limit and network into one `exit 1` saying the
  map *"may or may not exist"*. Split here: `7` is proven-absent, `11` is a precondition that could
  not be read, `8` is a write whose outcome is genuinely unknown.
- **Residual race, stated rather than closed.** Two runs between the same pair of search-and-create
  calls still mint two sessions. `16` catches it on the *next* invocation rather than preventing it.
  A verb claiming to close it would be lying.

---

## `grill round`

**Invocation**

```
fabrika grill round 9412 [--supersedes <id>]... [--repo <owner/name>]
```

Reads the round body from **stdin**. An example a caller can paste verbatim:

```
fabrika grill round 9412 <<'ROUND'
### 1 · fact
Does the vote table already carry a per-account weight column?

**Recommended:** Check the vote feature's schema before designing one.
ROUND
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<session>` | positional integer | yes | — | the session issue number the round is posted to |
| `--supersedes` | string, repeatable | no | none | a question id this round replaces; the named question is retired and stops holding the frontier |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the session lives in |

**Output** — machine. One JSON object; every key always present:

```json
{"session":9412,"round":2,"digest":"a1b2c3d4e5f6","questions":[{"id":"R2.1","kind":"fact"},{"id":"R2.2","kind":"decision"}],"supersedes":["R1.4"],"comment":5234567890,"supersedeComment":5234567891}
```

| Key | Type | Meaning |
|---|---|---|
| `session` | integer | the session issue number |
| `round` | integer | the round number this call minted, derived from the rounds already present |
| `digest` | string | the 12-hex round digest |
| `questions` | array | one object per question, in id order, each with `id` and `kind` |
| `supersedes` | array | the question ids this round retires, as given; empty when `--supersedes` was not passed |
| `comment` | integer | the id of the round comment |
| `supersedeComment` | integer or `null` | the id of the supersede-marker comment; `null` exactly when `supersedes` is empty |

The round number is **derived by the verb**, never supplied. The stdin headings carry only the
within-round position, and the verb stamps the full `R<round>.<n>` ids into the posted comment and
returns them here — so the caller learns its ids rather than guessing them.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `grill round: stdin was read and held nothing — refusing to post an empty round.` | 3 | refusal |
| `grill round: question <n> has no **Recommended:** field — every question carries a recommended answer.` | 4 | refusal |
| `grill round: decision question <n> has no **Trade-offs:** field.` | 4 | refusal |
| `grill round: question numbers are not contiguous from 1 — saw <list>.` | 4 | refusal |
| `grill round: heading "<text>" is not a question block.` | 4 | refusal |
| `grill round: kind "<value>" on question <n> is not one of fact, decision.` | 4 | refusal |
| `grill round: the body carries a machine-local path: <path> — refusing to post it.` | 5 | refusal |
| `grill round: the body is a bare @ path reference — not redactable, refusing to post it.` | 6 | refusal |
| `grill round: session #<n> does not exist, or is not a grilling session.` | 7 | refusal |
| `grill round: the comment write failed, so whether the round posted is UNKNOWN — read #<n> before re-running.` | 8 | refusal |
| `grill round: the round posted but the read-back does not match what was sent.` | 9 | refusal |
| `grill round: cannot read the existing rounds on #<n>: <reason> — the next round number is UNKNOWN. Nothing was posted.` | 11 | refusal |
| `grill round: --supersedes <id> names no question on #<n>.` | 13 | refusal |
| `grill round: --supersedes <id> was already superseded by round <n>.` | 18 | refusal |
| `grill round: the round posted as #<id> and the supersede marker failed — <ids> are NOT retired and still hold the frontier. Re-run grill round --supersedes on the new round, do not re-post the round.` | 8 | refusal |
| `grill round: the round holding <id> could not be digested: <reason> — the supersede binding is UNKNOWN. Nothing was posted.` | 14 | refusal |

**Scope** — every comment on the session, paginated, to derive the next round number. Zero existing
rounds is a fact (this is round 1). A comment read that could not complete is `11`.

**Superseding is the retraction path, and it is what keeps a session finishable.** A question that
went `stale` is un-ruled and holds the frontier at `awaiting-founder`. Nothing else retires it, so
without this flag a session in which any question was ever re-worded could **never** reach `clear`,
and `graduate` would never see a clear frontier — a liveness bug a graded eval run found after three
reviewers missed it. `--supersedes` makes the replacement explicit and auditable: the retired
question stays visibly on the record as `superseded`, naming the round that replaced it, which is
the #4227 requirement that a wrong recorded answer be retracted in the open rather than overwritten.

**Grounding**

- The grammar is validated **before** the write, so a malformed round is `4` with nothing posted
  rather than a comment somebody has to delete.
- v1's `add-frontier-ticket.sh:44` reports a filed-but-unlinked ticket's number only in prose on
  stdout and never reaches its machine `printf`, so the caller's capture is a sentence and the
  orphan is recorded nowhere. Here the comment id is a field of the exit-`0` object and there is no
  prose path that carries it.
- v1's frontier-filing fence (`wayfinder/SKILL.md:245`) discards the child number entirely and
  checks no exit status, so the next step has no number to reference.
- #4133 — briefs authored on a premise taken from the dispatcher rather than grounded at the source.
  A `fact` question exists so the premise gets grounded before it is built on.

---

## `grill answer`

**Invocation**

```
fabrika grill answer 9412 R2.1 --finding finding.md [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<session>` | positional integer | yes | — | the session issue number |
| `<question>` | positional string | yes | — | the question id, `R<round>.<n>` |
| `--finding` | path | yes | — | a file holding the established answer and the evidence it rests on |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the session lives in |

**Output** — machine. One JSON object; every key always present:

```json
{"session":9412,"question":"R2.1","kind":"fact","comment":5234567891,"recordedAs":"agent"}
```

| Key | Type | Meaning |
|---|---|---|
| `session` | integer | the session issue number |
| `question` | string | the question id answered |
| `kind` | string | always the literal `fact` — the kind guard admits nothing else |
| `comment` | integer | the id of the comment this call posted |
| `recordedAs` | string | always the literal `agent` |

`recordedAs` is present so a reader never infers authorship from the absence of a ruling marker —
the inference [#4619](https://github.com/kamp-us/phoenix/issues/4619) proves unsafe. The comment
carries a `grill-answered:` marker and never a `grill-ruled:` one.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `grill answer: --finding <path> is empty — refusing to record an answer with no content.` | 4 | refusal |
| `grill answer: the finding carries a machine-local path: <path> — refusing to post it.` | 5 | refusal |
| `grill answer: the finding is a bare @ path reference — not redactable, refusing to post it.` | 6 | refusal |
| `grill answer: session #<n> does not exist, or is not a grilling session.` | 7 | refusal |
| `grill answer: the comment write failed, so whether the answer posted is UNKNOWN — read #<n> before re-running.` | 8 | refusal |
| `grill answer: the answer posted but the read-back does not match what was sent.` | 9 | refusal |
| `grill answer: cannot read the rounds on #<n>: <reason> — whether <id> exists is UNKNOWN. Nothing was posted.` | 11 | refusal |
| `grill answer: <id> names no question on #<n>.` | 13 | refusal |
| `grill answer: <id> is a decision question — a decision is the founder's. Record his ruling with grill rule, or re-ask it as a fact.` | 17 | refusal |
| `grill answer: <id> was superseded by round <n> — answer the question that replaced it.` | 18 | refusal |

**Scope** — every comment on the session, paginated, to resolve `<id>` and its kind.

**Grounding**

- The kind guard is the mechanical half of the skill's division of labour. Recording an agent answer
  against a `decision` question is exactly the failure #4110 and #3148 record — work proceeding past
  a decision nobody made — so it is refused rather than warned about.
- #5103's acceptance criterion requires the founder's recorded decisions to be separable from the
  skill's own synthesis. A distinct marker format plus `recordedAs` is that separation, carried in
  the artifact rather than in a convention a later reader has to know.
- #4111 — agent self-reports were false twice and silently destroyed what they claimed to preserve.
  The finding is recorded as the agent's, never as authority.

---

## `grill rule`

Records a founder ruling. It is the only sanctioned path by which an agent records one.

**Invocation**

```
fabrika grill rule 9412 R2.3 --authorization authorization.md [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<session>` | positional integer | yes | — | the session issue number |
| `<question>` | positional string | yes | — | the question id being ruled, `R<round>.<n>` |
| `--authorization` | path | yes | — | a file quoting the founder's authorization **verbatim**, carrying an ISO-8601 date; posted as an adjacent comment, never summarized |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the session lives in |

**Output** — machine. One JSON object; every key always present:

```json
{"session":9412,"question":"R2.3","digest":"a1b2c3d4e5f6","authorization":5234567893,"marker":5234567892,"resolvesTo":"ruled"}
```

| Key | Type | Meaning |
|---|---|---|
| `session` | integer | the session issue number |
| `question` | string | the question id ruled |
| `digest` | string | the 12-hex digest of the round holding that question, as bound into the marker |
| `authorization` | integer | the id of the authorization comment, written **first** |
| `marker` | integer | the id of the `grill-ruled:` marker comment, written **second** |
| `resolvesTo` | string | always the literal `ruled` — the state `grill read` will report for this question, guaranteed because the verb digests the target round's **current** text, so clause 3 holds by construction at write time, and a retired target is refused at `18` |

**Write ordering is an invariant, not an implementation detail.** The authorization comment lands
first and the marker second, because a marker with no authorization beside it is void (#4938): an
interrupted run that wrote the marker first would leave a void ruling that a careless reader sees as
present, while the reverse leaves an authorization quote with no marker, which resolves to nothing
and harms no one. The implementation owes a test for the order.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `grill rule: the authorization carries a machine-local path: <path> — refusing to post it.` | 5 | refusal |
| `grill rule: the authorization is a bare @ path reference — not redactable, refusing to post it.` | 6 | refusal |
| `grill rule: session #<n> does not exist, or is not a grilling session.` | 7 | refusal |
| `grill rule: the authorization comment landed as #<id> and the marker write failed — the ruling is INCOMPLETE and does NOT count. Read #<n> before re-running.` | 8 | refusal |
| `grill rule: the marker posted but the read-back does not match what was sent.` | 9 | refusal |
| `grill rule: cannot resolve the invoking token's permission on <repo>: <reason> — authority is UNKNOWN, never granted. Nothing was posted.` | 11 | refusal |
| `grill rule: the invoking token resolves to <permission> on <repo>, below write — refusing to record a ruling.` | 12 | refusal |
| `grill rule: <id> names no question on #<n>.` | 13 | refusal |
| `grill rule: the round holding <id> could not be digested: <reason> — the binding is UNKNOWN. Nothing was posted.` | 14 | refusal |
| `grill rule: --authorization <path> is empty — a ruling with no quoted authorization is void (#4938).` | 15 | refusal |
| `grill rule: --authorization <path> carries no ISO-8601 date — the authorization must be dated.` | 15 | refusal |
| `grill rule: <id> is a fact question — establish it with grill answer; a fact is not the founder's to rule.` | 17 | refusal |
| `grill rule: <id> was superseded by round <n> — a retired question cannot be ruled. Rule the question that replaced it.` | 18 | refusal |

<!-- anchor: AUTHORIZATION-BINDS-ONE-QUESTION --> **An authorization binds the question it was given
about, and no other — and this is CONVENTION, not enforcement.** Say so plainly, because the
temptation is to claim otherwise. The verb digests the round holding the id it is *given*, so
stamping a three-day-old quote onto a brand-new, narrower question that a later round split out
**succeeds**: clause 3 holds by construction at write time, and nothing in the verb knows which
question the quote was originally about. `14` fires when a round cannot be digested and `18` when the
target is retired; neither detects a re-stamp.

So this sits beside "the quoted authorization is truthful" as the second thing no machine here can
check, and it is the agent's restraint that holds it. It is stated because two graded eval runs of
this very skill split on it — one refused a relayed ruling for want of fresh wording while another
re-stamped a three-day-old quote onto a question the founder had never seen — and the skill text at
the time supported both readings. A quote answering an older, broader question is **evidence for a
recommendation**, never a ruling on the new one.

**Scope** — the session's comments, to resolve `<id>` and digest its round; and one ACL read for the
invoking token. An ACL read that fails is `11` and writes nothing: authority is never granted by a
failed lookup.

**Examples**

```
$ fabrika grill rule 9412 R2.3 --authorization authorization.md
{"session":9412,"question":"R2.3","digest":"a1b2c3d4e5f6","authorization":5234567893,"marker":5234567892,"resolvesTo":"ruled"}
```

```
$ fabrika grill rule 9412 R2.3 --authorization empty.md
grill rule: --authorization empty.md is empty — a ruling with no quoted authorization is void (#4938).
$ echo $?
15
```

**Grounding**

- [#4938](https://github.com/kamp-us/phoenix/issues/4938) — the founder's ruled shape: a marker
  counts **iff** an adjacent comment quotes his session authorization verbatim with its date; a bare
  stamp is void. This verb is that ruling made mechanical.
- [#4646](https://github.com/kamp-us/phoenix/issues/4646) — the worked precedent, where an
  unverifiable relay hop parked a batch until the founder was asked directly, and the clearing
  comment says outright that it was posted on his instruction rather than typed by him.
- [#4441](https://github.com/kamp-us/phoenix/issues/4441) — **open**: a recorded ruling is
  indistinguishable from a fabricated one at the point it is recorded, and today's practice is prose
  self-attestation, which narrows nothing mechanically. This verb makes the authorization *required,
  quoted and bound*, which is strictly better than prose and still **not** proof of what he said.
  Nothing here closes #4441.
- v1's founder-answer seam specifies no format, no author check and no marker
  (`wayfinder/SKILL.md:419` — *"their call, in their own voice"*), so any comment by anyone reads as
  the ruling. That is the scar this verb and `grill read` exist to close.
- `pitch-guard`'s conjunctive clauses (`gh-issue-intake-formats.md:893`) are the adopted shape: any
  miss resolves to *not approved*, never to a warning.

---

## `grill read`

**Invocation**

```
fabrika grill read 9412 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<session>` | positional integer | yes | — | the session issue number to read |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the session lives in |

**Output** — machine. One JSON object:

```json
{"session":9412,"frontier":"awaiting-founder","questions":[{"id":"R1.1","kind":"decision","round":1,"text":"Do sellers set their own return windows?","state":"ruled","proof":"acl+authorization","author":"acme-founder","ruledAt":"2026-08-09T18:36:48Z"},{"id":"R1.2","kind":"decision","round":1,"text":"Does a partial return follow the same path?","state":"stale","boundDigest":"a1b2c3d4e5f6","currentDigest":"9f8e7d6c5b4a"},{"id":"R2.1","kind":"fact","round":2,"text":"Does the vote table carry a weight column?","state":"answered"},{"id":"R2.2","kind":"decision","round":2,"text":"Do vouched-in yazars inherit weight?","state":"open"}],"disregarded":[{"comment":5234567899,"reason":"malformed","detail":"marker naming R2.2 does not parse: digest field is not 12 lowercase hex"}],"counts":{"open":1,"stale":1,"answered":1,"ruled":1,"unattested":0,"superseded":0},"scanned":{"comments":14,"rounds":2,"authorsResolved":2}}
```

**Question row keys.** `id`, `kind`, `round`, `text` and `state` are present on **every** row.
`text` is the question prose as it currently reads, so a caller can name the open questions to the
founder without a second read. The remaining keys are **conditional**, and a consumer must treat
them as absent otherwise:

| Key | Present when | Meaning |
|---|---|---|
| `proof` | `state` is `ruled` | always `acl+authorization` — the clauses that were checked |
| `author` | `state` is `ruled` | the marker author's login, as resolved at the ACL |
| `ruledAt` | `state` is `ruled` | the marker's timestamp |
| `boundDigest` | `state` is `stale` | the digest the marker bound |
| `currentDigest` | `state` is `stale` | the round's digest as it reads now |
| `supersededBy` | `state` is `superseded` | integer — the round number that retired this question |

**How `answered` resolves, and what the answer marker's digest is for.** A `grill-answered` marker
resolves a `fact` question to `answered` on three clauses — the marker parses, its question id
exists, and **its author resolves to `write+` at the ACL**, a miss landing a `disregarded` row with
reason `unauthorized`. The ACL clause is here despite the marker carrying no founder authority,
because `answered` is not inert: `clear` requires every question to be `answered`, `ruled` or
`superseded`, and `clear` is the token `graduate` keys on — so an un-gated answer marker would let
any account with push access walk a session into the state that licenses spec synthesis. It is
**not** digest-gated. Its digest is **informational**:
it records which text was answered, so a reader can see the question moved, and it never changes the
state. **A re-worded `fact` therefore stays `answered`, deliberately** — `stale` exists to protect a
*ruling* from drifting out from under the founder, and a fact has no founder to protect. If a
re-worded fact needs re-establishing, ask it again in a new round with `--supersedes`.

**`state` is a closed set**: `open`, `answered`, `ruled`, `unattested`, `stale`, `superseded`.
`answered` occurs only on `kind: fact`; `ruled`, `unattested` and `stale` only on `kind: decision`;
`superseded` on either, and it always wins — a question a later round retired is `superseded`
whatever it was before, because its replacement is what the frontier now turns on.

**`frontier` is a closed set of four, and all four exit `0`:**

| Token | Meaning |
|---|---|
| `awaiting-founder` | at least one `decision` question is `open`, `unattested` or `stale` |
| `facts-pending` | no decision question awaits him, and at least one `fact` question is `open` |
| `clear` | every question is `answered`, `ruled` or `superseded` |
| `empty` | the session holds zero questions — a **fact**, the ordinary state of a session opened but not yet grilled |

**`disregarded`** is an array, empty when nothing was disregarded, of every purported marker this
verb did **not** count: `comment` (id), `reason` (closed set: `malformed`, `unauthorized`,
`unbindable`, `unattested`), and `detail` (a human-readable string). A clause-3 miss is **not** a
reason here — it is the question's own `stale` state, evidenced by the two digests on its row. It exists because a real ruling
written in the wrong shape must be *visible*, not silently absent.

**`counts`** carries `open`, `stale`, `answered`, `ruled`, `unattested` and `superseded`. **`scanned`** carries
`comments`, `rounds` and `authorsResolved`.

<!-- anchor: READ-NEVER-REFUSES-ON-CONTENT --> **This verb never refuses on marker content.** A
malformed marker, an unauthorized author, or a digest binding no round are all **data** — reported
in `disregarded` at exit `0`, with the affected question left `open`. Refusing would suppress the
entire frontier answer over one bad comment, and would let any account with write access disable the
verb by posting one malformed marker. Its only refusals are a session that does not exist (`7`) and
a read that could not complete (`11`).

**How a state is resolved.** A ruling resolves to `ruled` only when **all four clauses hold**. A miss
resolves by which clause missed, and there is no partial credit and no warning:

- **clause 1 or 2** — the question is `open`, and the marker lands a `disregarded` row.
- **clause 3** — the question is `stale`. It lands **no** `disregarded` row: the row would
  duplicate `boundDigest`/`currentDigest`, which the question row already carries, and `stale` is a
  question state rather than a disregarded marker.
- **clause 4** — the question is `unattested`, and the marker lands a `disregarded` row with reason
  `unattested`.

The four clauses:

1. the marker's author resolves to `admin`, `maintain` or `write` at
   `repos/<repo>/collaborators/<login>/permission`, via the shipped `resolveOwnership`
   (ADR [0055](../../../../.decisions/0055-acl-sourced-review-authz.md)) — **fail-closed**. A
   permission read that *fails* is UNKNOWN rather than a demotion, so it is `11` for the whole run
   rather than a silent `open` on that row;
2. the question id names a question that exists in the round the digest identifies;
3. the digest matches that round's **current** question text — a miss here is `stale`;
4. an adjacent authorization comment exists and carries an ISO-8601 date.

<!-- anchor: NO-DIRECT-VS-RELAYED-SPLIT --> **Clause 4 admits no exception, and that is deliberate.**
An earlier draft of this contract split `ruled-direct` (a bare marker, "authored directly") from
`ruled-relayed` (a marker with authorization) and treated the bare one as the stronger. That was
wrong twice over: *authored directly* is not a checkable property, because every crew agent writes
to GitHub as the founder's account and the 2026-08-09 ruling on
[#4619](https://github.com/kamp-us/phoenix/issues/4619#issuecomment-5230098869) settles that filings
from that account read as agent-authored regardless of the footer; and #4938 declares a bare stamp
**void**. So a bare marker resolves to `unattested` — surfaced, never counted — whoever appears to
have posted it.

**What `ruled` proves, exactly.** That a `write+` account posted a marker binding this question's
current text, with a dated authorization comment beside it. It does **not** prove the quoted
authorization is a truthful record of what the founder said; nothing mechanical can, and #4441 is
open on it. The `proof` field names the clauses that were checked rather than implying more.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `grill read: session #<n> does not exist, or is not a grilling session.` | 7 | refusal |
| `grill read: cannot read the comments on #<n>: <reason> — every question's state is UNKNOWN, never "open".` | 11 | refusal |
| `grill read: cannot resolve <login>'s permission on <repo>: <reason> — the marker on <id> is UNKNOWN, never disregarded and never counted. Re-run.` | 11 | refusal |

**Scope** — every comment on the session, paginated, plus one ACL read per distinct marker author.
The scope line on stderr names the comment count, the round count and the number of authors
resolved, because the frontier token is only readable against them. **Zero comments is a fact**
(`empty`); a comment read that could not complete is `11`. An unpaginated read would silently drop
the newest rounds and report a ruled question as open — the fail-open direction, which is why
pagination is load-bearing rather than hygiene.

**Examples**

```
$ fabrika grill read 9412
{"session":9412,"frontier":"awaiting-founder","questions":[{"id":"R1.1","kind":"decision","round":1,"text":"Do vouched-in yazars inherit weight?","state":"open"}],"disregarded":[],"counts":{"open":1,"stale":0,"answered":0,"ruled":0,"unattested":0,"superseded":0},"scanned":{"comments":3,"rounds":1,"authorsResolved":0}}
$ echo $?
0
```

```
$ fabrika grill read 9412 --repo kamp-us/nonexistent
grill read: session #9412 does not exist, or is not a grilling session.
$ echo $?
7
```

**Grounding**

- v1 spells its fork marker three different ways (`wayfinder/SKILL.md:396`, `:253`,
  `shared/wayfinder-map-issue-shape.md:95`) and its shape contract explicitly licenses *"read
  tolerantly, write canonically"* (`:113`), so the awaiting-versus-ruled state is **not
  machine-decidable by construction** — only an LLM can read it, which is precisely the ad-hoc
  parsing that same skill bans. One canonical marker per meaning, parsed by one total reader, is the
  fix.
- v1 also encodes the state as *which markdown section a bullet sits under*, in a body no shipped
  tool writes (`wayfinder-map` is read-only, `command.ts:8`). State here lives in a marker, not in
  document position.
- `pipeline-cli wayfinder-map` reports a malformed map and **returns normally**
  (`command.ts:76-79`), so exit status cannot separate malformed from valid and a caller keying on
  it reads a broken map as fine. Here the split is carried in `disregarded` at exit `0`, which is
  readable without keying on status at all.
- `DANGLING_FRONTIER_REF` self-disables on an empty sub-issue read (`validate.ts:130`) — the
  zero-scope pass ADR 0092 forbids. Here a failed comment read is `11`, never an empty frontier.
- #4153 — a gate decision reached by arguing from a decision record rather than by checking the
  authority. This verb checks the authority; nothing on the page is a trust signal.
- #4227 — a confident wrong assertion propagating downstream. `stale`, `unattested`, `superseded`
  and `proof` exist so a reader downstream can see exactly how much a recorded answer is worth.
- **A graded eval run, not a reviewer, found that `stale` had no exit.** Three review passes cleared
  a design in which a re-worded question held the frontier forever, so `clear` was unreachable and
  `graduate` could never run on that session. `superseded` and `grill round --supersedes` are that
  fix. Recorded because it is the sharpest instance here of a reviewer confirming a thing is written
  down while a run has to actually do it.

---

## Required repo files (verb-level)

fabrika installs into repos that are not phoenix. The **when-missing** vocabulary is closed and is
the same in every fabrika skill, so one reader parses all of them: **fail-loud** (stop, name the
surface by its repo-relative path, point at front-door), **degrade** (continue with a narrower
answer, stated), **bootstrap** (front-door creates it — [#4952](https://github.com/kamp-us/phoenix/issues/4952)).

| Must exist | Why | When missing |
| --- | --- | --- |
| `gh` authenticated to `--repo` with `issues: write` | every verb reads or writes an issue or comment over REST | **fail-loud** — `11` before any write, `8` after one; never a silent empty answer |
| The `grilling:session` label | `grill open` applies it on mint and resumes on it | **bootstrap** (front-door, #4952); until then `grill open` exits `7` naming the label |
| `repos/<repo>/collaborators/<login>/permission` readable | clause 1 of every ruling (ADR 0055) | **fail-loud** — `11`, and every question's state is UNKNOWN: never `open`, never `ruled`. The load-bearing row — a degrade here would silently license the exact failure the skill exists to prevent |

Nothing else. No `.decisions/`, no `.patterns/`, no CODEOWNERS, no merge-queue configuration, no
design manifest: this group opens no pull request and gates no merge. Stated explicitly, because an
absent row reads as nobody checked.

## Completeness self-test

The six presence tests in the [interface convention Part 2](../../docs/cli-interface-convention.md)
hold: every flag has a type and a default, every stdout shape is shown by an example, every non-zero
code is enumerated with its trigger, every error names its message, stream and code, every judging
verb states its scope and zero-scope behaviour, and no clause defers to a v1 script, another skill's
prose, or the authoring session.

The five hand-checks those tests cannot perform:

1. **Every reachable outcome has a code.** Walked per verb against the failure modes each can
   actually hit. Two that nearly escaped: `grill rule` writing its authorization successfully and
   then failing the marker write — an INCOMPLETE ruling that would read as present, seated on `8`
   with a message naming the orphaned comment and a specified write order that makes the surviving
   half the harmless one; and `grill open` creating an issue whose label write then fails, leaving a
   session no later run can find, also `8` and named.
2. **Every value an example prints is derivable from the spec.** The digest is defined as an
   algorithm over named fields, not shown as a magic literal; `created`, `recordedAs`, `resolvesTo`,
   `state`, `frontier`, `proof` and `disregarded[].reason` are all closed sets enumerated above.
3. **Every literal obeys the spec's own stated formats.** Every digest literal is exactly 12
   lowercase hex; every timestamp is ISO-8601 UTC with a `Z`; every question id matches
   `R<round>.<n>`; every JSON example parses; every issue number used as an example sits well above
   the host repository's live range so no example reads as a claim about a real issue.
4. **Every value a later verb needs arrives as an argument.** No clause refers to "the digest at
   round time" or "the questions you posted": `grill rule` and `grill read` re-derive the digest from
   the session's own comments. The only state threaded between verbs is the session number and the
   question id, both explicit positionals.
5. **Every conditional output key states when it is present.** `grill read`'s row keys are split
   into always-present and conditional, with the condition named per key, so a consumer never has to
   infer optionality from an example.

**No local scratch state, so the shared-state law has no surface here.** Every artifact this group
touches lives on GitHub keyed by issue and comment id; no verb writes a temp directory, so the
session-keyed collision recorded at #4516 cannot occur. Stated because an absent answer to that
question reads as one nobody asked.
