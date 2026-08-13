# `/wayfinding` — derived CLI contract

**Skill:** [`wayfinding`](SKILL.md) · **Authoring brief:** [#5018](https://github.com/kamp-us/phoenix/issues/5018) · **Date:** 2026-08-10

**Where these verbs land.** `packages/fabrika-cli/`, under a **`map`** subcommand group registered
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

**The group name.** `map`, free against
[`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts) when this was written; the
registered groups were `adr build epic eval hook ledger plan report review review-ui ship spend
triage ui wire`. That list grows most weeks — `ledger` landed during this authoring session — so
read the file rather than this sentence. `map` is the verb group; `wayfinding` is the skill.

**What fabrika already ships, reused — never respecified.** Each is imported, not restated, because
a transcription drifts and a pointer to code cannot:

- [`src/io/issues.ts`](../../../../packages/fabrika-cli/src/io/issues.ts) — `getIssue`,
  `listComments`, `createIssue`, `createComment`, `patchIssueBody`, `addLabels`,
  `openIssuesWithLabel`, `searchOpenIssues`, `pagedJson`, `scanJsonPages`. Its
  **`Existence<A>` = `Present | Absent | Unknown`** is the type this group's whole read story rests
  on: it keeps a proven 404 apart from an unreachable GitHub, which is exactly the distinction the
  dependency-edge reads need (see *The edge reads* below).
- [`src/report/leaks.ts`](../../../../packages/fabrika-cli/src/report/leaks.ts) — `scanBody`,
  `isBareAtReference`, `renderLeaks`. Pure, zero imports.
- [`src/report/dedup.ts`](../../../../packages/fabrika-cli/src/report/dedup.ts) — `tokenize`,
  `scoreTitle`, `rank`, `TOKEN_FLOOR`. Pure. `map open`'s already-charted check is built on this
  **module**, not on a call to `report dedup`; a verb whose only behaviour was relaying that answer
  is what ADR 0238 forbids.
- [`src/report/compose.ts`](../../../../packages/fabrika-cli/src/report/compose.ts) —
  `normalizeForReadback`. Read-backs compare normalized, never byte-identical.
- [`src/review/append.ts`](../../../../packages/fabrika-cli/src/review/append.ts) — `appendOnly`,
  `grewByOne`. The append-only fence over an issue body; `map descope` is exactly that shape.
- [`src/io/pulls.ts`](../../../../packages/fabrika-cli/src/io/pulls.ts) — `permissionFor`,
  `viewerLogin`. The ACL read itself, and the only part of the claim story this group reuses.

**Read for its shape, NOT imported.** [`src/build/claim.ts`](../../../../packages/fabrika-cli/src/build/claim.ts)
is the model for marker-based claiming, and its stated invariant is the one this group inherits —
*a permission read that fails is UNKNOWN, never a demotion*. It cannot be called here:
`composeMarker` hardcodes the `build-claim:` prefix, its `MARKER_RE` matches only that grammar, and
`resolveOwnership` resolves ownership by comparing a **session** token. This group's markers use a
different prefix and its lanes are keyed on a **run nonce**, so `markersIn` would find zero markers
on a frontier ticket and `resolveOwnership` would answer *unclaimed* on every call — a lane that can
never see a sibling lane's claim, which is precisely the collision the nonce exists to prevent. The
`map` group therefore authors its own marker grammar, parser and nonce-keyed resolution, listed as
its own registration row below.
- [`src/verb.ts`](../../../../packages/fabrika-cli/src/verb.ts) `answer` / `refuse`, and the `emit`
  adapter each group copies.

**Considered and deliberately not derived.**

- **A `map assess` verb.** An earlier draft had one: it would have reported whether a destination is
  fog before `map open` minted anything. Dropped, because its whole behaviour is relaying the
  answer `map open` already computes on its own refusal path — the wrapper shape ADR 0238 names.
  The gate is `map open`'s refusal instead, which is strictly better: the check fires at the moment
  the claim is made, and **nothing is written when it fails**.
- **A verb that decides whether a destination is fog.** That judgment is the wrapper's
  ([`SKILL.md`](SKILL.md) §1) and, at intake, ADR
  [0203](../../../../.decisions/0203-fog-reports-route-to-wayfinder-backlog.md)'s. A verb guessing
  it would be a stochastic answer wearing a deterministic exit code, **and** a second answer to a
  question already ruled. `map open` checks only the mechanical half — that questions were supplied,
  that none is already answered, that the destination is not already charted or descoped.
- **A verb that closes or graduates the map.** Emission is `graduate`'s (#5017 amendment, ADR
  0246). v1 scripted only the destructive half of this — closing the map — and left the safe half
  (annotate, stay open) as prose, so the ergonomic branch was the irreversible one. Here neither
  branch is ours.
- **A verb that runs question rounds.** `grilling` is the shared primitive and owns rounds,
  recommended answers, and the four-clause ruling attestation. Reimplementing any of it here would
  duplicate the machinery the packaging ruling explicitly puts in one place.
- **A merge-gating verdict.** `wayfinding` is deliberately absent from `SHIP_NAMESPACES`
  ([`src/review/classes.ts`](../../../../packages/fabrika-cli/src/review/classes.ts)) and emits no
  verdict marker, so `wire/verdict-marker.ts`'s `NAMESPACE` regex and its separate
  `NAMESPACE_PREFIXES` gate are **not** widened. Nothing recorded here can block a merge; widening
  either would create the second human gate #4631 rules out.
- **A second answer to triage's classification, to control-plane membership, or to pitch approval.**
  Each is enforced at its own gate. This group states expectations and computes none of them.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `map open` | mint or resume the map for a destination, refusing a destination that is not fog | the search, the dedup rank, the already-descoped scan and the resume-versus-mint decision are total functions of the destination string and the repository's state; *whether the thing is worth charting* is the caller's |
| `map read` | the parser — five sections, one row per frontier ticket with a closed-set state, the frontier token, and the body digest | parse, resolve edges, compare; the whole state is checkable by construction |
| `map ticket` | file a frontier ticket, link it as a sub-issue, set its blocking edges, and splice its line onto the map — one act | the link, the edges and the splice are mechanical; *what question to ask* is the skill's |
| `map lane` | claim a research lane on one ticket, keyed on the run nonce, refusing a `decision` ticket | a compare-and-set on a marker under a closed-set kind guard; who to dispatch is the skill's |
| `map finding` | close a lane with an outcome from a closed set | the outcome vocabulary is closed and the binding is mechanical; the finding's content is judgment |
| `map fork` | record that a ticket's question is being answered elsewhere — a `decision` in a `grilling` session, an empirical question in a `prototyping` spike | a bound splice under a closed-set kind guard; recognizing which kind a question is remains the skill's |
| `map record` | the lockstep — the answer lands under decisions, the ticket moves to graduated fog, the sub-issue closes | three writes with one specified order and one guard; nothing here is judgment |
| `map descope` | append a rejected direction and its reasoning to the never-graduating out-of-scope section, optionally retiring the frontier ticket that asked it | an append-only splice under the same guard |

## The map body this group WRITES

Five sections, in this order, and nothing else:

```markdown
## Destination
How vouched yazars earn moderation weight.

## Decisions
- Weight is earned per account, never inherited from a kefil. — ruled on #9301 R2.3

## Frontier
- #9142 · research — does better-auth mint a single-use token without a new table?
- #9144 · decision — does an invited çaylak start at 0 karma? — forked to #9301

## Fog
- Whether weight decays, and on what clock.

## Out of scope
- A per-topic weight multiplier. Re-proposed twice; rejected because it makes every moderation
  action's authority unreadable without a topic lookup. — 2026-08-10
```

- `## Destination` is one or two sentences. `map open` sets it; no other verb rewrites it.
- `## Decisions` entries are append-only and **each cites its authority** — `— ruled on #<session>
  <question-id>` for a founder ruling relayed from a `grilling` session, or `— from #<ticket>` for a
  research finding. An entry with neither is `4`.
- `## Frontier` rows are `- #<n> · <kind> — <question>`, with `<kind>` from `research | prototype |
  decision`, optionally followed by ` — forked to #<session>`. The row is a **rendering** of state
  the reader resolves from markers and edges, never the record of it.
- `## Fog` is free prose — what is still unnamed.
- `## Out of scope` is append-only and never empties. Each entry states the direction, why it was
  rejected, and an ISO date.

A missing section, a section out of order, or an unparseable entry is `4`.

<!-- anchor: EMPTY-IS-WELL-FORMED --> **An empty section is well-formed, and `4` never fires on
one.** A map at mint has an empty `## Decisions`, `## Frontier` and `## Out of scope` — that is the
ordinary opening state, and it is exactly what `map read` reports as `frontier: "empty"` at exit `0`.
A verb that refused an empty section would make every freshly minted map unreadable by the next verb
that touched it.

<!-- anchor: POSITION-IS-A-RENDERING --> **A line's section is not its state.** v1 encoded ticket
state as which heading a bullet sat under, in a body no shipped tool wrote, and then had to read
"tolerantly" to cope with its own drift. Here `map read` resolves state from the ticket's marker,
its `state` on GitHub, and its edges; the body rows are re-rendered from that. An implementer who
derives state by matching headings has rebuilt the scar.

## The ticket marker

One `wire`-shaped marker, first line of the ticket's opening comment, composed with
`src/build/claim.ts`'s `composeMarker`:

```
map-ticket: #9140 · research · 7f3a9c21
```

The map number binds the ticket to its map, the kind is from the closed set, and the trailing field
is the **run nonce** of the run that filed it. A ticket whose marker names a different map is not
this map's ticket, whatever the sub-issue edge says — the edge can be added by anyone.

**Stated, not yet enforced.** This marker's schema module and its row in
[`src/wire/registry.ts`](../../../../packages/fabrika-cli/src/wire/registry.ts) land with the
implementation ([#5022](https://github.com/kamp-us/phoenix/issues/5022)). Until then nothing in the
shipped package recognizes the key, and no claim here describes present behaviour.

## The body digest, and its neutrality invariant

The digest is the first 12 characters of the lowercase hex SHA-256 of the map body's **five section
bodies in order**, LF-normalized, with trailing whitespace stripped per line and the section
headings themselves excluded.

<!-- anchor: DIGEST-COVERS-WHAT-IT-GUARDS --> **Named invariant — the digest covers exactly the
bytes a write can change, and nothing outside them.** Unlike a verdict digest, this one is a
compare-and-set token, not an attestation: it exists to detect that the body moved, so it must cover
every byte a concurrent writer could have moved and no byte this group never touches. The headings
are excluded because no verb rewrites them and including them would make a heading-whitespace
normalization by another tool read as a lost update. Issue metadata — title, labels, assignees — is
excluded for the same reason: `map open` writes the label once and nothing else touches it, so
folding it in would fire on a change no write of ours conflicts with.

The implementation owes a deterministic test that a body round-tripped through
`normalizeForReadback` yields the byte-identical digest, and that each of `map ticket`, `map fork`,
`map record` and `map descope` changes it.

## The edge reads

Frontier topology is stored in GitHub's native issue-dependency and sub-issue relationships, never
in the body. Four endpoints, all REST (skill conventions
[§11](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)), all paginated:

| Read | Endpoint | Proven-empty vs unknown |
|---|---|---|
| the map's children | `GET repos/<repo>/issues/<map>/sub_issues` | `200` with `[]` is a proven-empty child set; a non-404 error is `Unknown` |
| what a ticket waits on | `GET repos/<repo>/issues/<n>/dependencies/blocked_by` | same |
| what a ticket gates | `GET repos/<repo>/issues/<n>/dependencies/blocking` | same |
| a cheap summary | the issue payload's `issue_dependencies_summary` and `sub_issues_summary` | fields, not a separate call |

Writes: `POST repos/<repo>/issues/<n>/dependencies/blocked_by` and
`POST repos/<repo>/issues/<map>/sub_issues`.

<!-- anchor: EDGE-BODY-TAKES-AN-INTERNAL-ID --> **Both POST bodies take the target's internal `id`,
not its issue number**, and the sub-issue key is the singular `sub_issue_id`. Passing a number
silently addresses a different issue. This is the trap v1 already recorded once for `sub_issue_id`;
the dependency endpoints repeat it, so the implementation resolves the id with `getIssue` and never
interpolates a number into either body.

<!-- anchor: 404-IS-A-VERDICT --> **A 404 on a dependency read is a verdict about the issue, not
about its edges.** The endpoint returns `200 []` for a real issue with no edges and `404` for an
issue that does not exist, so the two are distinguishable — but only if existence is established
separately. A verb that read `[]` and reported "no blocking edges" without knowing the issue exists
would print a proven negative over zero scope, which is #4752's class and ADR
[0092](../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)'s prohibition. Every edge
read here is preceded by an `Existence` read of the ticket, and a `404` is `13`.

**Verified against the live platform**, not asserted from documentation: the two dependency
endpoints answer `200 []` on an existing issue and `404` on a nonexistent one, and
`issue_dependencies_summary` is `{blocked_by, blocking, total_blocked_by, total_blocking}` on the
issue payload. Re-probe on an API-version bump rather than trusting this paragraph.

**Pagination is load-bearing, not hygiene.** An unpaginated `blocked_by` read returns a plausible
first page, so a frontier that "looks clear" at 30 edges would be reported clear with nothing
marking it wrong — the fail-open direction.

## Shared conventions

Every `map` verb obeys these; stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else. Scope lines,
  refusal reasons and progress go to stderr. **A non-zero exit prints nothing on stdout** — the
  shipped `refuse` helper hardcodes empty stdout, so a partial answer beside a failure code is not
  constructible here and must not be specified.
- **A proven outcome is a state word at exit `0`, never a non-zero code.** `map read`'s frontier
  token is the worked case: `awaiting-founder`, `lanes-pending`, `clear` and `empty` are four
  answers and **all four exit `0`**. A frontier holding open questions is this skill working, and
  seating it on a non-zero code would make a caller's `[ $? -ne 0 ]` read "the fog is not cleared
  yet" as "the verb never ran".
- **A 404 is a verdict; anything else is UNKNOWN.** A missing map or ticket is `7` or `13`. An
  unreachable or erroring GitHub is `11` before any write and `8` after one.
- **Common inputs.** `--repo <owner/name>` (default: resolved from the `origin` remote) on every
  verb. There is no `--json` flag: the answer channel is already one JSON object.
- **The body guard.** Every verb that writes the map body takes `--digest` and refuses with `12`
  when the recomputed digest differs. The write is a **slice**, not a reconstruction: bytes outside
  the spliced section survive verbatim, so a concurrent edit to another section is never clobbered
  even when the guard admits the write.
- **GitHub access follows skill conventions §11 — REST, never GraphQL**, paginated.
- **Every text this group sends to GitHub is leak-scanned** with `src/report/leaks.ts` before the
  write — bodies, comments, and the issue titles `map open` and `map ticket` compose. A
  machine-local path is `5`, a bare `@` reference is `6`. **Widening stated:** the base's `5` reads
  *"…and `--redact` was not given"*; no `map` verb offers `--redact`, so here `5` fires on any
  machine-local path unconditionally. The condition narrows; the meaning does not drift.
- **Every write is read back** and compared with `normalizeForReadback`; a mismatch is `9`.
- **Error messages are prefixed with the invoked verb's name** — `map record: …`.
- **A non-zero exit is UNKNOWN to the caller until the code is read.**

### The shared exit matrix

This table owns `code → meaning`. Per-verb **Errors** tables below own only that verb's own
triggers. `1`, `126` and `127` are stated **here and only here**, and every verb can return them. `0` is
restated per verb because each verb's `0` names a different answer.

| Code | Meaning | `open` | `read` | `ticket` | `lane` | `finding` | `fork` | `record` | `descope` |
|---|---|---|---|---|---|---|---|---|---|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | `EMPTY_STDIN` — stdin was read and held nothing | ✓ | — | — | — | — | — | — | — |
| `4` | `BAD_SECTIONS` — a required section is missing, out of order, or holds an unparseable entry | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| `5` | `LEAKED_PATH` — the text carries a machine-local path | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| `6` | `BARE_AT_PATH` — the text is a bare `@` path reference | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| `7` | `NO_TARGET` — the map issue or the label does not exist | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `8` | `WRITE_UNKNOWN` — the write failed, so the outcome is UNKNOWN | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `9` | `READBACK_MISMATCH` — the write landed, the read-back differs | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `10` | `DELIBERATE_GAP` — held empty, see below | — | — | — | — | — | — | — | — |
| `11` | `PRECONDITION_UNKNOWN` — a precondition read failed; nothing written | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `12` | `DIGEST_STALE` — the body moved since `--digest` was taken | — | — | ✓ | — | — | ✓ | ✓ | ✓ |
| `13` | `TICKET_UNKNOWN` — the number names no frontier ticket of this map | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `14` | `EDGE_UNRESOLVABLE` — an edge target is not a ticket of this map, or would cycle | — | — | ✓ | — | — | — | — | — |
| `15` | `LANE_NOT_MINE` — the nonce does not hold this ticket's lane | — | — | — | ✓ | ✓ | — | — | — |
| `16` | `MAP_AMBIGUOUS` — more than one open map matches the destination | ✓ | — | — | — | — | — | — | — |
| `17` | `NOT_FOG` — proven: the destination carries no surviving open question | ✓ | — | — | — | — | — | — | — |
| `18` | `TICKET_RETIRED` — the ticket already left the frontier, graduated or retired | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `19` | `ALREADY_DESCOPED` — the destination or direction is already recorded out of scope | ✓ | — | ✓ | — | — | — | — | ✓ |
| `20` | `KIND_MISMATCH` — the ticket's kind does not admit this verb | — | — | — | ✓ | ✓ | ✓ | — | — |
| `21` | `OUTCOME_UNRECORDABLE` — the lane returned no answer to record | — | — | — | — | — | — | ✓ | — |

**`3`–`11` are imported from
[`src/report/codes.ts`](../../../../packages/fabrika-cli/src/report/codes.ts)**, not restated as
numerals, so a drift is unrepresentable rather than merely detectable. `12`–`21` are the group's own
and clear the base's occupied seats; they carry **no** cross-group uniqueness obligation, so
`build`'s `12` and this group's `12` are two namespaces rather than a collision.

**`10` is a deliberate gap**, exported as a `DELIBERATE_GAP` constant on the shipped `ui`
precedent, which holds seat `3` the same way (`src/ui/codes.ts:29`,
`export const DELIBERATE_GAP = REPORT_EMPTY_STDIN`) and which `exit-code-alignment.ts` excludes
from `allocatedCodes`, so the hold is neither a drift nor a collision. The base's `10` fires when a **title or label** carries a
type or priority classification. No `map` verb accepts a label flag, none writes a `type:`,
`status:` or priority label, and `map open` and `map ticket` compose their titles without ever
classifying them — the verbs run no such check at all, so the condition is unreachable rather than
merely unused.

<!-- anchor: WHY-NOT-FOG-IS-17-NOT-4 --> **Why a not-fog destination is `17` and not `4`.** A
destination that names a deliverable is not a defect in the *input document* — the questions the
caller supplied may be perfectly well-formed prose. `4` is imported from the base as *a required
section is missing, out of order, or empty*, and overloading an imported constant with a second
meaning is exactly the drift the import exists to stop. `17` also carries a different remedy: `4`
says fix the text, `17` says file this in intake instead.

**Registration burden the implementer inherits — four distinct registration edits beyond the
group's own `src/map/command.ts` and `src/map/codes.ts`, none implied by the others.**

1. `src/registry.ts` — add `mapCommand` to `registeredGroups`.
2. `src/exit-code-alignment.ts` — add `map` to `ALIGNED_GROUPS`. Its value is a `SharedSeats` map
   keyed by **this group's own export names**, and **none of the shipped maps fits**: the eight-seat
   maps key on `ZERO_SCOPE` and `OFF_VOCABULARY`, `HOOK_SEATS` shares only the stdin seat, and `map`
   names `7` `NO_TARGET` and holds `10` as `DELIBERATE_GAP` so it cannot claim `OFF_VOCABULARY` at
   all. A new `MAP_SEATS` constant is authored in that same file.
3. `src/exit-code-alignment.unit.test.ts` — add a `map` row to the hand-written `TABLES` map, or
   the on-disk-versus-registered coverage assertion reds the moment `src/map/codes.ts` exists.
4. The `map-ticket` wire format, with its schema module, its `src/wire/registry.ts` row, and its
   `wire-formats.md` section — without the last, `src/wire/index-doc.unit.test.ts` reds.

**Not widened, deliberately.** `wire/verdict-marker.ts`'s `NAMESPACE` regex, its separate
`NAMESPACE_PREFIXES` gate, `SHIP_NAMESPACES`, `CLASS_NAMES` and `SHIP_CLASS_NAMES` are all left
alone: this group emits no verdict marker and gates no merge. An implementer who widens them has
added the second human gate the skill's `NO-SECOND-GATE` anchor rules out.

**One vocabulary this group is NOT a member of, stated because it bites the ship gate rather than
the code.** `src/eval/corpus.ts`'s `STAGES` is `["triage", "build", "review", "ship-it"]`, so the
ideation layer has no stage to declare an eval entry under. That is a corpus-wide gap affecting the
whole quintet, owned by [#4649](https://github.com/kamp-us/phoenix/issues/4649)'s harness rather
than by this contract, and it is recorded here so an implementer meets it as a known absence rather
than as a surprise.

---

## `map open`

**Invocation**

```
fabrika map open --destination "how vouched yazars earn moderation weight" [--repo <owner/name>]
```

Reads the caller's enumerated open questions from stdin, one per line.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--destination` | string | yes | — | the fog to chart, as a short noun phrase; becomes the map's title and its `## Destination` |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the map lives in |

**Output** — machine. One JSON object:

```json
{"map":9140,"created":true,"destination":"how moderation weight is earned","questions":2,"answeredCandidates":[{"question":"does weight inherit from a kefil?","candidates":[{"issue":9098,"score":7,"title":"Moderation weight is earned per account"}]}],"digest":"a1b2c3d4e5f6","scanned":{"maps":7,"candidates":0}}
```

`created` is `false` on a resume. `questions` counts the supplied lines that parsed as questions and are now the map's
opening fog. `answeredCandidates` is an array, one row per supplied question that ranked against
anything on the board, each carrying the candidate issues with their overlap scores.

<!-- anchor: RANKING-IS-EVIDENCE-NOT-PROOF --> **`answeredCandidates` is advisory and this verb
never refuses on it.** Title-token overlap can rank a question against an issue; it cannot prove the
issue answers it. Seating a `NOT_FOG` refusal on a ranking would dress a stochastic judgment in a
proven exit code — the defect this contract refuses elsewhere. So the verb reports the evidence with
its scores and charts every supplied question; deciding that a candidate really settles one is the
skill's, and a question it settles is one the caller does not carry forward. `digest` is the body digest of the map
as it now reads, so the caller can write without a second call. `scanned` names how many open maps were searched and how
many ranked as candidate duplicates — the scope the resume-versus-mint decision rests on.

**What it checks before it mints, in this order.** Each of the refusing checks is mechanical; none
is a judgment about whether the fog is worth charting.

1. **Stdin held at least one question.** Zero is `3`.
2. **Each line parses as a question** — it ends in `?`, or opens with one of a closed set of
   interrogatives (`what who when where why which how does do is are can should would will`). This
   is a **grammar** check on the input document, which is what makes `17` provable: the verb is not
   deciding that the destination is a deliverable, it is reporting that nothing you handed it was
   stated as a question. If **no** line parses, that is `17`.
3. **Each question is ranked against the board** with `src/report/dedup.ts` over open and closed
   issues, and the candidates are reported in `answeredCandidates`. This step never refuses — see
   the anchor below.
4. **The destination is not already recorded out of scope** on any open map — `19`.
5. **The destination is not already charted** — an open `wayfinding:map` whose destination ranks
   above `TOKEN_FLOOR` is resumed, not duplicated. Two or more is `16`.

<!-- anchor: THE-GATE-IS-EVIDENCE-NOT-VERDICT --> **This is the fog-or-ticket test's checkable
half, and it is deliberately not the whole test.** Whether something is genuinely fog is a judgment
the skill carries; what a verb can prove is that the caller enumerated questions, that they are
still open, and that nobody has charted or rejected this destination already. That is what makes a
wrong classification catchable at the point it is made rather than well-formed and wrong (#4227) —
the claim is bound to an enumerable artifact instead of to the caller's confidence. It is **not** a
second answer to ADR 0203's discriminator, which is seated at intake and which this verb expects
rather than recomputes.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the map exists and its number is on stdout |
| `3` | stdin was read and held no question |
| `4` | an existing map's body does not parse into the five sections |
| `5` / `6` | the destination or a question carries a machine-local path, or is a bare `@` reference |
| `7` | the `wayfinding:map` label does not exist in the repository |
| `8` / `9` | the create or label write failed, or its read-back differs |
| `11` | the map search or a dedup read failed; nothing was written |
| `16` | more than one open map matches the destination |
| `17` | no supplied line parses as a question |
| `19` | the destination is already recorded out of scope on an open map |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map open: stdin was read and held no question — a destination with no open question is not fog.` | 3 | refusal |
| `map open: the wayfinding:map label does not exist in <repo> — refusing to open an unlabelled map no later run could find.` | 7 | refusal |
| `map open: created #<n> and the label write did NOT land — the map exists and no later run can find it. Add wayfinding:map to #<n> by hand.` | 8 | refusal |
| `map open: cannot search <repo> for existing maps: <reason> — nothing was written and whether this destination is charted is UNKNOWN.` | 11 | refusal |
| `map open: <k> open maps match this destination (#<a>, #<b>) — refusing to guess which; close or merge one.` | 16 | refusal |
| `map open: none of the <k> supplied line(s) is stated as a question — a destination with no stated question is not fog. This belongs in intake, not on a map.` | 17 | refusal |
| `map open: this destination is recorded out of scope on map #<n> (<date>) — read the recorded reasoning before re-proposing it.` | 19 | refusal |

**Scope** — every open issue carrying `wayfinding:map`, paginated, plus one dedup read per supplied
question over open and closed issues. The scope line on stderr names both counts. **Zero open maps is a fact**, not a failed
read: the first map in a repository is the ordinary case. A search that could not complete is `11`.

**What it writes.** The title is the destination verbatim, prefixed `wayfinding: ` and truncated to
250 characters on a word boundary. The body is the five sections in order, with `## Destination`
holding the `--destination` string, `## Fog` holding one `- ` bullet per surviving question in the
order they arrived on stdin, and `## Decisions`, `## Frontier` and `## Out of scope` present and
empty:

```markdown
## Destination
how moderation weight is earned

## Decisions

## Frontier

## Fog
- does a suspended account keep its weight?
- what clock does weight decay on?

## Out of scope
```

**On a resume the body is not touched at all.** The supplied questions are reported back in
`questions` and `answeredCandidates` and are otherwise discarded: appending them would duplicate
fog a previous session already recorded, and this verb takes no `--digest`, so it holds no guard
that would make a body write safe.

**Write order, and what a partial application leaves.** The issue is created **first**, the label
second. A failure between them leaves a map issue nobody can find, which is `8` with the number
named on stderr so a human can finish it — the surviving half is inert rather than harmful. The
reverse order is not available (a label cannot be applied to an issue that does not exist), which is
why the orphan is named rather than prevented.

**Examples**

```
$ printf 'does a suspended account keep its weight?\nwhat clock does weight decay on?\n' | fabrika map open --destination "how moderation weight is earned"
{"map":9140,"created":true,"destination":"how moderation weight is earned","questions":2,"answeredCandidates":[],"digest":"a1b2c3d4e5f6","scanned":{"maps":7,"candidates":0}}
$ echo $?
0
```

```
$ printf 'build the invite acceptance form\n' | fabrika map open --destination "the invite acceptance form"
map open: none of the 1 supplied line(s) is stated as a question — a destination with no stated question is not fog. This belongs in intake, not on a map.
$ echo $?
17
```

**Grounding**

- v1 searched for nothing before minting: *"With no map yet, open a new issue carrying the
  `wayfinder:map` label"* (`wayfinder/SKILL.md:195`), so two maps for one destination is its
  ordinary outcome and the decisions recorded on the unread one did not happen.
- ADR 0203 seats the fog-versus-buildable call at intake. This verb expects that answer and checks
  evidence; it does not recompute the routing.
- #4227 — a well-formed wrong classification propagating unchallenged. The `17` path is what makes
  the classification refutable at the moment it is asserted.
- #4154 / #4148 — `intake-dedup` matches only the issue itself on a 12-token AND query, and is
  open-only so a charted-and-closed destination reads as new. This verb uses the pure `dedup`
  module with its own scope (open maps, and closed issues for the answered-question check) rather
  than inheriting either scar.
- #3086 — a machine-local path leaked into a posted body; the title is scanned, not only the body.

---

## `map read`

**Invocation**

```
fabrika map read 9140 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<map>` | positional integer | yes | — | the map issue number to read |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the map lives in |

**Output** — machine. One JSON object:

```json
{"map":9140,"frontier":"awaiting-founder","digest":"a1b2c3d4e5f6","destination":"how moderation weight is earned","tickets":[{"number":9142,"kind":"research","question":"which table carries the per-account weight column?","state":"open","blockedBy":[],"blocking":[9143]},{"number":9143,"kind":"research","question":"where does the weight audit record live?","state":"lane-held","nonce":"7f3a9c21","blockedBy":[9142],"blocking":[]},{"number":9146,"kind":"research","question":"does the audit log already record weight changes?","state":"lane-closed","outcome":"no-evidence","blockedBy":[],"blocking":[]},{"number":9144,"kind":"decision","question":"does a suspended account keep its weight?","state":"forked","session":9301,"blockedBy":[],"blocking":[]},{"number":9141,"kind":"research","question":"is a per-account weight column representable today?","state":"graduated","blockedBy":[],"blocking":[]},{"number":9147,"kind":"prototype","question":"what would a decay curve feel like in the moderation queue?","state":"retired","retiredBy":"a decay curve nobody can predict","blockedBy":[],"blocking":[]}],"outOfScope":[{"direction":"a per-topic weight multiplier","reason":"it makes every moderation action's authority unreadable without a topic lookup","recordedAt":"2026-06-29"},{"direction":"importing the old forum's reputation score","reason":"the old score counted post volume, the behaviour this system exists to stop rewarding","recordedAt":"2026-07-02"}],"fog":1,"counts":{"open":1,"lane-held":1,"lane-closed":1,"forked":1,"graduated":1,"retired":1,"blocked":1},"disregarded":[{"ticket":9148,"reason":"malformed","detail":"map-ticket marker names no kind from the closed set"}],"scanned":{"children":6,"edgeReads":12,"comments":14}}
```

**Ticket row keys.** `number`, `kind`, `question`, `state`, `blockedBy` and `blocking` are present
on **every** row. The remaining keys are **conditional**, and a consumer must treat them as absent
otherwise:

| Key | Present when | Meaning |
|---|---|---|
| `nonce` | `state` is `lane-held` | the run nonce holding the lane |
| `session` | `state` is `forked` and `kind` is `decision` | the `grilling` session issue the decision lives in |
| `spike` | `state` is `forked` and `kind` is `prototype` | the `prototyping` spike issue the empirical question lives in |
| `outcome` | `state` is `lane-closed` | the closed-set lane outcome — `answered`, `no-evidence` or `unreachable` |
| `retiredBy` | `state` is `retired` | the out-of-scope direction the ticket was retired into |

**`state` is a closed set of six**: `open`, `lane-held`, `lane-closed`, `forked`, `graduated`,
`retired`. `forked` occurs only on `kind: decision`. `lane-closed` means a lane returned and its
`outcome` says what it returned — the ticket is not yet on the map. `graduated` and `retired` are
the two terminal states and always win: a ticket whose answer landed under `## Decisions` and whose
issue is closed is `graduated`, and one closed into the out-of-scope section is `retired`, whatever
either was before.

<!-- anchor: EVERY-TICKET-HAS-AN-EXIT --> **Named invariant — every ticket has a path off the
frontier, including one nobody can answer.** A `lane-closed` ticket whose outcome is `answered` or
`no-evidence` leaves by `map record`: both are findings, and *"the audit log does not record weight
changes"* is an answer the destination needs. A ticket whose outcome is `unreachable` has **no**
answer, so `map record` refuses it (`13`) — it leaves either by being re-laned once the source is
reachable, or by `map descope --ticket`, which retires it into the out-of-scope section with the
reason nobody could answer it. Without that second exit a permanently unreachable question would
hold the frontier forever, `clear` would be unreachable, and `graduate` could never run on the map —
the same liveness defect a graded run found in `grilling`, where a re-worded question held the
frontier with nothing to retire it.

**A ticket is `blocked` when its `blockedBy` holds an unresolved ticket**, which is a derived
property reported in `counts` rather than a `state` — a ticket can be both `open` and blocked, and
collapsing them would lose which. This is derived, never stored: whether a standalone issue may
carry stored blockedness is open at [#4840](https://github.com/kamp-us/phoenix/issues/4840), and
this verb takes no position on it. The native edges here are map topology, and the derivation stays
in the reader.

**`frontier` is a closed set of four, and all four exit `0`:**

| Token | Meaning |
|---|---|
| `awaiting-founder` | at least one `decision` ticket is `open` or `forked` — only a decision awaits *him*; a `prototype` ticket out at a spike is work in flight, not a question he owes |
| `lanes-pending` | no decision ticket awaits him, and at least one ticket is `open`, `lane-held`, `lane-closed`, or a `prototype` that is `forked` |
| `clear` | every ticket is `graduated` or `retired` — the map hands to `graduate` |
| `empty` | the map holds zero tickets — a **fact**, the ordinary state of a map opened but not yet decomposed |

**`outOfScope`** is an array of the never-graduating section's entries, each carrying `direction`,
`reason` and `recordedAt`. The reasoning is returned in full rather than as a count, because the
whole point of the section is that the next session reads *why* something was rejected — a count
would tell a caller that a rejection exists and leave it unable to say anything about it.

**`disregarded`** is an array, empty when nothing was disregarded, of every child this verb did
**not** count as a frontier ticket: `ticket` (its number), `reason` (a closed set — `malformed`,
`foreign-map`, `unauthorized`), and `detail`, a human-readable string. A child whose `map-ticket`
marker does not parse, names a different map, or was filed by an author who does not resolve to
`write+` lands here rather than in `tickets`, so a ticket that *looks* like this map's is visible
rather than silently absent.

<!-- anchor: READ-NEVER-REFUSES-ON-CONTENT --> **This verb never refuses on a ticket's content.** A
ticket whose marker is malformed, or whose kind is off-vocabulary, is reported in `disregarded` at
exit `0`, never a refusal — refusing would suppress the whole frontier
over one bad comment and would let anyone with write access disable the verb by filing one. Its only
refusals are a map that does not exist (`7`), a body that does not parse (`4`), and a read that could
not complete (`11`).

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the map's state is on stdout |
| `4` | the body does not parse into the five sections, in order |
| `7` | the map does not exist, or does not carry `wayfinding:map` |
| `11` | the child, edge or comment read failed — the frontier is UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map read: #<n> does not exist, or is not a wayfinding map.` | 7 | refusal |
| `map read: #<n>'s body does not hold the five sections in order (<detail>) — refusing to report a frontier parsed from a body this verb cannot read.` | 4 | refusal |
| `map read: cannot read #<n>'s children: <reason> — the frontier is UNKNOWN, never empty.` | 11 | refusal |
| `map read: cannot read #<t>'s dependency edges: <reason> — the topology is UNKNOWN, never unblocked.` | 11 | refusal |

**Scope** — every child of the map, paginated; both edge lists per child, paginated; every comment
on the map and on each child, paginated. The scope line on stderr names all three counts, because
the frontier token is only readable against them. **Zero children is a fact** (`empty`); a child or
edge read that could not complete is `11`, never an empty frontier.

<!-- anchor: NEVER-PASS-ON-A-FAILED-READ --> v1's dangling-reference check disabled itself whenever
the sub-issue read came back empty (`wayfinder-map/validate.ts:130`, `if (subIssues.length > 0)`),
so a rate-limited call silently removed the check rather than refusing — the zero-scope pass ADR 0092
forbids. Here an empty read that cannot be proven empty is `11`.

**Examples**

```
$ fabrika map read 9140
{"map":9140,"frontier":"empty","digest":"0f1e2d3c4b5a","destination":"how moderation weight is earned","tickets":[],"outOfScope":[],"fog":1,"counts":{"open":0,"lane-held":0,"lane-closed":0,"forked":0,"graduated":0,"retired":0,"blocked":0},"disregarded":[],"scanned":{"children":0,"edgeReads":0,"comments":1}}
$ echo $?
0
```

```
$ fabrika map read 9999
map read: #9999 does not exist, or is not a wayfinding map.
$ echo $?
7
```

**Grounding**

- `pipeline-cli wayfinder-map` prints a malformed verdict and **returns normally**
  (`wayfinder-map/command.ts:71-79`), so exit status cannot separate a valid map from a broken one
  and a caller running `wayfinder-map N && proceed` proceeds on a broken map. Here a body that does
  not parse is `4` and a valid one is `0`.
- The same tool reports `MISSING_FRONTIER_SECTION` **and** `graduation-ready` in one exit-`0` run,
  because a drifted heading yields zero entries and readiness is *"answerable frontier is empty"*
  (`validate.ts:42-43`). Here a body that does not parse never produces a frontier token at all.
- v1's structured output is opt-in behind `--json` while the default is English prose
  (`command.ts:67-69`), so the shape a skill captures by default is sentences. Here the channel is
  machine, unconditionally.
- v1 encoded ticket state as document position in a body no shipped tool wrote
  (`wayfinder-map/github.ts:184`, *"Read-only by construction"*), then licensed *"read tolerantly,
  write canonically"* (`shared/wayfinder-map-issue-shape.md:114`) — tolerance on read plus hand
  writes is a drift generator with no detector.

---

## `map ticket`

**Invocation**

```
fabrika map ticket 9140 --digest a1b2c3d4e5f6 --kind research --question "does better-auth mint a single-use token without a new table?" [--blocks 9143] [--blocked-by 9142] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<map>` | positional integer | yes | — | the map this ticket belongs to |
| `--digest` | string | yes | — | the body digest from `map read`; the write is refused if the body moved |
| `--kind` | choice | yes | — | one of `research`, `prototype`, `decision` — what clears this ticket |
| `--question` | string | yes | — | the open question, stated without answering it |
| `--blocks` | integer, repeatable | no | none | a ticket of this map that cannot proceed until this one clears |
| `--blocked-by` | integer, repeatable | no | none | a ticket of this map this one waits on |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"map":9140,"ticket":9145,"kind":"research","blockedBy":[9142],"blocking":[],"digest":"b2c3d4e5f6a1"}
```

`digest` is the map's digest **after** the splice, so a caller filing several tickets threads it
forward without re-reading between calls.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the ticket exists, is linked, its edges are set, and its line is on the map |
| `4` | the map body does not parse |
| `5` / `6` | the question carries a machine-local path, or is a bare `@` reference |
| `7` | the map does not exist |
| `8` / `9` | a write failed, or the read-back differs |
| `11` | a precondition read failed; nothing was written |
| `12` | the recomputed body digest differs from `--digest` |
| `13` | a `--blocks` or `--blocked-by` target is not a ticket of this map |
| `14` | an edge would cycle, or an edge write could not be bound to an internal id |
| `18` | a `--blocks` or `--blocked-by` target already left the frontier |
| `19` | the question restates a direction already recorded out of scope on this map |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map ticket: #<n>'s body moved since --digest <d> (now <e>) — nothing was written. Re-read and re-apply.` | 12 | refusal |
| `map ticket: --blocked-by <t> is not a frontier ticket of map #<n>.` | 13 | refusal |
| `map ticket: --blocks <t> would close a cycle (<a> -> <b> -> <a>) — refusing to make a frontier no run can drain.` | 14 | refusal |
| `map ticket: cannot resolve <t>'s internal id: <reason> — an edge POST takes the id, never the number. Resolved before the create, so nothing was written.` | 14 | refusal |
| `map ticket: filed #<c> and the sub-issue LINK to #<n> did NOT land — the ticket exists and is not on the map. Link it before charting on.` | 8 | refusal |
| `map ticket: --blocked-by <t> already left the frontier — a cleared question cannot gate an open one.` | 18 | refusal |
| `map ticket: "<question>" restates a direction recorded out of scope on #<n> (<date>) — nothing was written. Read the recorded reasoning before charting it.` | 19 | refusal |

**Scope** — the map's existing children and their edges, to validate every edge target and to detect
a cycle. Zero children is a fact when no edge flag was passed, and is `13` when one was.

**Preconditions resolve before anything is written.** Every `--blocks` and `--blocked-by` target is
existence-checked, confirmed to be a ticket of this map, and resolved to its internal id, and the
cycle check runs — all before the create. That ordering is what makes `13`, `14`, `18` and `20`
honestly mean *nothing was written*: an id that cannot be resolved is discovered while the frontier
is still untouched, rather than after a ticket exists.

**Write order, and what each partial application leaves.** Create the ticket, post its marker
comment, link it as a sub-issue, set the edges, then splice the map body — in that order, and the
body guard is re-checked immediately before the splice.

- A failure after the create leaves an issue with no marker: `8`, with the number on stderr. `map
  read` does not count it as a ticket of this map — an unmarked child is not a frontier ticket — so
  it is inert rather than half-present, and a re-run with the same question resumes it.
- A failure after the marker leaves a marked, unlinked ticket: `8`, number named.
- A failure after the link leaves a linked ticket with no edges and no body row: `8`. `map read`
  reports it, because the reader derives the frontier from children and markers rather than from
  body rows — which is the whole reason state does not live in the body.
- The splice is last because it is the only write that can be lost to a concurrent writer, so it
  spends the shortest possible time between the guard and the write.

**What it writes on the ticket.** The title is the question verbatim, truncated to 250 characters on
a word boundary. The body is the question, then a `Charted on #<map>.` line. The marker comment is
the single line specified in *The ticket marker* above, and nothing else.

**Examples**

```
$ fabrika map ticket 9140 --digest a1b2c3d4e5f6 --kind research --question "does better-auth mint a single-use token without a new table?"
{"map":9140,"ticket":9145,"kind":"research","blockedBy":[],"blocking":[],"digest":"b2c3d4e5f6a1"}
$ echo $?
0
```

```
$ fabrika map ticket 9140 --digest 000000000000 --kind decision --question "does an invited çaylak start at 0 karma?"
map ticket: #9140's body moved since --digest 000000000000 (now b2c3d4e5f6a1) — nothing was written. Re-read and re-apply.
$ echo $?
12
```

**Grounding**

- v1's `add-frontier-ticket.sh` files the child, then links it, and on a link failure prints prose
  and exits before `printf '%s\n' "$CHILD_NUMBER"` ever runs (`:44-47`) — so the orphan's number
  survives only inside an English sentence and a re-run files a duplicate. Here the number is named
  in the refusal and a re-run resumes.
- The same script writes its refusals with bare `echo` to **stdout** (`:34`), the channel carrying
  the issue number, against its own library's stated contract that *"stdout is the ANSWER"*
  (`lib/common.sh:31`).
- v1 never validates that the parent is a map (`add-frontier-ticket.sh:21`, `MAP="$1"` used
  directly in the `sub_issues` POST), so a wrong number silently parents the ticket under an
  arbitrary issue. Here the map's existence and label are a precondition.
- v1's skill invokes the script bare, with no capture and no `|| exit` (`SKILL.md:245-247`), so a
  failed file or link is invisible and the walk reports a charted map anyway.
- The frontier row is written by the same act that creates the ticket, because v1 split them
  (`SKILL.md:252`, prose-only) and the split is where the two drift.

---

## `map lane`

**Invocation**

```
fabrika map lane 9140 --ticket 9143 --nonce 7f3a9c21 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<map>` | positional integer | yes | — | the map the ticket belongs to |
| `--ticket` | integer | yes | — | the frontier ticket to claim a research lane on |
| `--nonce` | string | yes | — | this run's nonce, matching `^[0-9a-f]{8}$` — the lane key. A value outside that grammar is a usage error (`1`), so a human-readable label like `run-1`, which two runs would collide on, is refused rather than accepted |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"map":9140,"ticket":9143,"nonce":"7f3a9c21","lane":"held"}
```

`lane` is a closed set of two: `held` (this nonce now holds it) and `resumed` (this nonce already
held it — a re-run is not an error).

<!-- anchor: LANE-KEY-IS-THE-RUN-NONCE --> **The lane key is the caller's run nonce, never a
session id and never a process id.** `$CLAUDE_CODE_SESSION_ID` is **pane-constant, not per-run**
(#5028), and sibling subagents of one parent share it (#4516), so two lanes of one charting run
would key onto one namespace and each would classify the other's claim as its own. The nonce is
generated once per run by the caller and passed explicitly, which is also what keeps it out of
session memory: no verb infers it from the environment.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the lane is held by this nonce |
| `7` | the map does not exist |
| `8` / `9` | the claim write failed, or its read-back differs |
| `11` | the comment read failed; nothing was written |
| `13` | `--ticket` is not a frontier ticket of this map |
| `15` | another nonce holds this ticket's lane |
| `18` | the ticket already left the frontier |
| `20` | the ticket's kind is `decision` — it is routed, never researched |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map lane: #<t>'s lane is held by <other> since <iso> — refusing to open a second lane on one ticket.` | 15 | refusal |
| `map lane: #<t> is not a frontier ticket of map #<n>.` | 13 | refusal |
| `map lane: #<t> already left the frontier — there is nothing left to research.` | 18 | refusal |
| `map lane: #<t> is a decision ticket — it is the founder's to answer. Route it with map fork, never a lane.` | 20 | refusal |
| `map lane: cannot read #<t>'s comments: <reason> — whether a lane is held is UNKNOWN, never free.` | 11 | refusal |

**Scope** — every comment on the ticket, paginated, plus one ACL read per distinct claim author via
`resolveOwnership`. A claim by an author who does not resolve to `write+` is not a claim. **A
permission read that fails is `11` for the whole run**, never a demotion that would silently free
someone else's lane.

**Examples**

```
$ fabrika map lane 9140 --ticket 9143 --nonce 7f3a9c21
{"map":9140,"ticket":9143,"nonce":"7f3a9c21","lane":"held"}
$ echo $?
0
```

**Grounding**

- #4516 / #5028 — the scratch namespace keyed on a session id collides across sibling lanes and
  roles, and `(session, pid)` is pane-constant rather than per-run. The nonce is the fix, and it is
  an argument rather than an environment read so nothing can re-derive it wrongly.
- #4060 — a classifier that read zero files under parallel invocation and silently defaulted to a
  plausible answer. A lane that cannot prove it is free refuses.
- v1 has no lane concept at all: its one-ticket-per-session law is prose with *"no counter, no
  marker, no check"* (`wayfinder/SKILL.md:282, :344`). This verb is the marker that law needed.
- `epic-lock`'s scars, designed out: it never reads back the presence stamp it writes
  (`epic-lock/github.ts:131`), so an abandoned lock wedges the epic forever, and it collapses five
  distinct refusals onto one exit code. Here `15`, `13`, `18` and `11` are four seats with four
  remedies.

---

## `map finding`

**Invocation**

```
fabrika map finding 9140 --ticket 9143 --nonce 7f3a9c21 --outcome answered --finding finding.md [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<map>` | positional integer | yes | — | the map the ticket belongs to |
| `--ticket` | integer | yes | — | the ticket whose lane is closing |
| `--nonce` | string | yes | — | the nonce holding the lane, matching `^[0-9a-f]{8}$` |
| `--outcome` | choice | yes | — | one of `answered`, `no-evidence`, `unreachable` — what the lane established |
| `--finding` | path | conditional | — | the finding, required when `--outcome answered`, optional otherwise |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"map":9140,"ticket":9143,"outcome":"answered","comment":9234567891,"lane":"released"}
```

<!-- anchor: NOTHING-IS-NOT-EMPTY --> **The outcome vocabulary keeps three answers apart that an
absence would collapse into one.** `answered` means the lane established the fact and the finding
carries it. `no-evidence` means the lane looked and the evidence is not there — a **result**, and
the finding, when given, records where it looked. `unreachable` means the lane could not look at
all: the source was unavailable, the dispatch failed, the lane returned nothing. A verb that
accepted a silent empty finding would let all three arrive as one, which is exactly how a
zero-files-read classifier ships a plausible answer (#4060). There is no fourth value and no
default: `--outcome` is required, and an off-vocabulary value is a usage error at parse (`1`).

This verb writes a comment on the **ticket** and releases the lane. It does **not** touch the map
body — that is `map record`, deliberately separate, so the lane traffic of a parallel burndown never
contends on the one body every lane shares.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the finding is recorded and the lane is released |
| `4` | `--outcome answered` was given with no `--finding`, or the file is empty |
| `5` / `6` | the finding carries a machine-local path, or is a bare `@` reference |
| `7` | the map does not exist |
| `8` / `9` | the comment write failed, or its read-back differs |
| `11` | a precondition read failed; nothing was written |
| `13` | `--ticket` is not a frontier ticket of this map |
| `15` | `--nonce` does not hold this ticket's lane |
| `18` | the ticket already left the frontier |
| `20` | the ticket's kind is `decision` — a decision has no lane |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map finding: --outcome answered requires --finding — an answered lane with no finding is indistinguishable from one that found nothing.` | 4 | refusal |
| `map finding: --finding <path> is empty — an empty finding is not an answer; use --outcome no-evidence.` | 4 | refusal |
| `map finding: <nonce> does not hold #<t>'s lane (held by <other>) — nothing was recorded.` | 15 | refusal |

**Scope** — the ticket's comments, paginated, to resolve the lane holder. A read that could not
complete is `11`.

**Examples**

```
$ fabrika map finding 9140 --ticket 9143 --nonce 7f3a9c21 --outcome no-evidence
{"map":9140,"ticket":9143,"outcome":"no-evidence","comment":9234567891,"lane":"released"}
$ echo $?
0
```

```
$ fabrika map finding 9140 --ticket 9143 --nonce 7f3a9c21 --outcome answered
map finding: --outcome answered requires --finding — an answered lane with no finding is indistinguishable from one that found nothing.
$ echo $?
4
```

**Grounding**

- #4060 — the distinguishability requirement in full: a lane that returned nothing and a lane whose
  answer is "nothing is there" are different facts with different next steps.
- #3709 — parallel lanes conflicting on one shared file. Lane traffic writes to the ticket, not to
  the map, so the shared body sees one write per *resolution* rather than one per lane event.
- v1 records an answer straight into the map body via a CLI verb that does not exist
  (`wayfinder/SKILL.md:328`), so in practice the agent hand-edits the body — the unguarded
  read-modify-write this split removes.

---

## `map fork`

**Invocation**

```
fabrika map fork 9140 --digest a1b2c3d4e5f6 --ticket 9144 --session 9301 [--repo <owner/name>]
```

```
fabrika map fork 9140 --digest a1b2c3d4e5f6 --ticket 9147 --spike 9310 [--repo <owner/name>]
```

Exactly one of `--session` or `--spike` is given, and which one is admitted is decided by the
ticket's kind, not by the caller: `decision` takes `--session`, `prototype` takes `--spike`, and
`research` takes neither (it is laned, not routed). Supplying both, neither, or the one the kind
does not admit is `20`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<map>` | positional integer | yes | — | the map the ticket belongs to |
| `--digest` | string | yes | — | the body digest from `map read` |
| `--ticket` | integer | yes | — | the `decision` ticket being routed |
| `--session` | integer | conditional | no default; required when the ticket's kind is `decision`, and refused otherwise | the `grilling` session issue the decision now lives in |
| `--spike` | integer | conditional | no default; required when the ticket's kind is `prototype`, and refused otherwise | the `prototyping` spike issue the empirical question now lives in |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"map":9140,"ticket":9144,"session":9301,"state":"forked","digest":"c3d4e5f6a1b2"}
```

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the fork is recorded on the map and the ticket |
| `4` | the map body does not parse |
| `5` / `6` | text carries a machine-local path, or is a bare `@` reference |
| `7` | the map does not exist |
| `8` / `9` | a write failed, or the read-back differs |
| `11` | a precondition read failed; nothing was written |
| `12` | the body moved since `--digest` |
| `13` | `--ticket` is not a frontier ticket of this map, or `--session` is not a `grilling` session |
| `18` | the ticket already left the frontier |
| `20` | `--ticket`'s kind is not `decision` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map fork: #<t> is kind <k>, not decision — a fork routes a decision; re-file it as a decision ticket or resolve it in a lane.` | 20 | refusal |
| `map fork: #<s> is not a grilling session — refusing to point a fork at an issue no grilling run will read.` | 13 | refusal |

<!-- anchor: TWO-ROUTES-ONE-SHAPE --> **A decision and an empirical question route the same way,
to different skills.** A `decision` is answered in conversation and belongs to `grilling`; an
**empirical** question — one only running throwaway code can settle, not conversation and not a
subagent reading source — belongs to `prototyping`, which produces one disposable spike answering
ONE named question. This verb records *where* either is being answered and nothing about the answer.
It is an invocation seam only: neither skill's internals are specified here, this group runs no
spike, and no verb in it writes code. A spike's captured decision comes back through `map record`
exactly as a ruling does.

<!-- anchor: RELAY-THE-RULING-NEVER-ASSERT-ONE --> **This verb records where the decision is being
made; it never records the decision.** A ruling reaches `## Decisions` only through `map record`
citing a `grilling` question id, and `grilling` is what resolves that question's state against the
ACL and its authorization. Nothing here writes an authority claim, and no flag accepts one. v1's
whole given-grounding law reduced to the agent typing `(@founder)` after an entry
(`wayfinder/SKILL.md:161`) that nothing verified — the parenthetical was the attestation.

**Scope** — the ticket's kind marker and the session's label. A read that could not complete is `11`.

**Examples**

```
$ fabrika map fork 9140 --digest a1b2c3d4e5f6 --ticket 9144 --session 9301
{"map":9140,"ticket":9144,"session":9301,"state":"forked","digest":"c3d4e5f6a1b2"}
$ echo $?
0
```

**Grounding**

- v1's fork marker is spelled three different ways across two files (`wayfinder/SKILL.md:396, :253`,
  `shared/wayfinder-map-issue-shape.md:95`) and its shape doc licenses reading tolerantly, so the
  awaiting-versus-ruled state is not machine-decidable by construction — only a model can read it,
  which is the ad-hoc parsing the same skill bans.
- Nothing in v1's shell distinguishes a fork from an investigation: `add-frontier-ticket.sh:24-30`
  accepts both type labels identically, so an agent that mislabels a fork resolves the founder's
  decision on its own authority and no artifact records that it did. Here `kind` is a closed set in
  a marker and `13` is the refusal.
- #4441 — a relayed ruling is indistinguishable from a fabricated one at the point it is recorded.
  This group does not record rulings at all; it points at the session that does.

---

## `map record`

**Invocation**

```
fabrika map record 9140 --digest a1b2c3d4e5f6 --ticket 9143 --finding finding.md [--ruled-on 9301 --question-id R2.3] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<map>` | positional integer | yes | — | the map the ticket belongs to |
| `--digest` | string | yes | — | the body digest from `map read` |
| `--ticket` | integer | yes | — | the ticket whose answer is landing |
| `--finding` | path | yes | — | the answer, as it will read under `## Decisions` |
| `--ruled-on` | integer | conditional | no default; required when a `forked` ticket's kind is `decision` | the `grilling` session the ruling was recorded in |
| `--spike` | integer | conditional | no default; required when a `forked` ticket's kind is `prototype` | the `prototyping` spike whose captured decision this records |
| `--question-id` | string | conditional | no default; required when `--ruled-on` is given | the question id in that session, matching `R<round>.<n>` |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"map":9140,"ticket":9143,"recorded":"— from #9143","closed":true,"digest":"d4e5f6a1b2c3"}
```

**The lockstep, and the order that makes a partial application safe.** Three writes, one guard:

1. the answer is appended under `## Decisions` with its authority citation, and the ticket's row is
   removed from `## Frontier` — **one body PATCH**, so the two cannot separate. There is no
   graduated-fog section: `map read` derives `graduated` from the decision entry citing the ticket
   plus the ticket's own closed state, so a fourth rendering of that fact would be a third home for
   one meaning;
2. the ticket issue is closed.

<!-- anchor: LOCKSTEP-IS-ONE-WRITE-THEN-ONE --> **The move is one body write, not two.** v1 spread
the append, the row move, and the close across three unrelated acts with no transaction
(`wayfinder/SKILL.md:328, :334`), so a failure between them produced exactly the state its own shape
doc forbids — *"the map is never left in a state where a resolved unknown has no recorded answer"*
(`shared/wayfinder-map-issue-shape.md:73`). Folding the two body edits into one PATCH makes that
state unrepresentable. The close is second and its failure is `8` with the ticket named: an answer
recorded against a still-open ticket is visibly incomplete and re-runnable, whereas a closed ticket
with no recorded answer is the forbidden state.

**A `forked` ticket may not be recorded without its ruling.** `--ruled-on` and `--question-id` are
required when the ticket's state is `forked`.

<!-- anchor: RELAY-GRILLINGS-STATE-NEVER-RECOMPUTE-IT --> **The ruling's state is read by importing
the `grill` group's reader, never by re-deriving it here.** A ruling counts only when four clauses
hold — the marker author resolves to `write+` at the ACL, the question id exists in the round the
marker's digest names, the digest matches that round's current text, and an adjacent dated
authorization comment exists. Those clauses are `grill read`'s to resolve, and a second
implementation of them in this group would be a second answer to a question already enforced
elsewhere: the two could disagree, and the one that said `ruled` would win by being called.

A `prototype` ticket's return path is the same shape and a shorter check: `--spike` names the spike
issue, the verb confirms it exists and is closed, and the finding carries the captured decision. A
spike is disposable by charter, so nothing here reads its code and no verb in this group ever writes
any — the map records what the spike *decided*, never what it built.

So `map record` imports the `grill` group's question-state reader and branches on the state word it
returns. The closed set is `open`, `answered`, `ruled`, `unattested`, `stale`, `superseded`; only
`ruled` admits a record, and every other value is `13` with the state named. `--question-id` matches
`R<round>.<n>`. `map fork` checks only that `--session` carries the `grilling:session` label, which
is a plain label read and needs no import.

**Sequencing this creates, stated because an implementer inherits it:** the `grill` group ships from
[#5023](https://github.com/kamp-us/phoenix/issues/5023) and this group from
[#5022](https://github.com/kamp-us/phoenix/issues/5022). Until that reader exists, `map record` on a
`forked` ticket refuses `11` — the ruling's state is UNKNOWN, never assumed `ruled` — and the
research path is unaffected. Both groups are fabrika's own; nothing here reaches outside it (ADR
0238).

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the answer is on the map and the ticket is closed |
| `4` | the map body does not parse, or `--finding` is empty |
| `5` / `6` | the finding carries a machine-local path, or is a bare `@` reference |
| `7` | the map does not exist |
| `8` / `9` | a write failed, or the read-back differs |
| `11` | a precondition read failed; nothing was written |
| `12` | the body moved since `--digest` |
| `13` | `--ticket` is not a ticket of this map, or its ruling does not read `ruled` |
| `18` | the ticket already left the frontier |
| `21` | the ticket's lane outcome is `unreachable`, so there is no answer to record |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map record: #<t> is forked to #<s> and --ruled-on was not given — a forked ticket's answer is the founder's, and it is recorded by citing his ruling, never by restating it.` | 13 | refusal |
| `map record: #<s> <q> reads <state>, not ruled — nothing was recorded. A question that is not ruled has no answer to carry onto the map.` | 13 | refusal |
| `map record: #<t>'s lane returned unreachable — there is no answer to record. Re-lane it once the source is reachable, or retire it with map descope --ticket.` | 21 | refusal |
| `map record: recorded the answer on #<n> and the close of #<t> did NOT land — the answer is on the map and the ticket is still open. Close #<t> by hand.` | 8 | refusal |

**Scope** — the ticket's state and, for a forked ticket, the named session's question state. A read
that could not complete is `11`.

**Examples**

```
$ fabrika map record 9140 --digest a1b2c3d4e5f6 --ticket 9143 --finding finding.md
{"map":9140,"ticket":9143,"recorded":"— from #9143","closed":true,"digest":"d4e5f6a1b2c3"}
$ echo $?
0
```

**Grounding**

- The lockstep invariant is v1's own, stated and unenforced.
- #4227 — a wrong recorded answer is retracted in the open, never quietly overwritten. This verb
  appends; it never rewrites an existing decision entry. A superseded decision is a new entry naming
  what it replaces, which is also what keeps the body digest's guarantee meaningful.
- v1's `MALFORMED_DECISION_ENTRY` requires a `— from #N` origin on every entry
  (`wayfinder-map/Defect.ts:32`) and nothing ever ran the validator (`wayfinder/SKILL.md:226`).
  Here the citation is composed by the verb, so it cannot be omitted.

---

## `map descope`

**Invocation**

```
fabrika map descope 9140 --digest a1b2c3d4e5f6 --direction "a per-topic weight multiplier" --reason reason.md [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<map>` | positional integer | yes | — | the map to record against |
| `--digest` | string | yes | — | the body digest from `map read` |
| `--direction` | string | yes | — | the rejected direction, as a short noun phrase |
| `--reason` | path | yes | — | why it was rejected; quoted onto the map verbatim |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"map":9140,"direction":"a per-topic weight multiplier","entries":3,"digest":"e5f6a1b2c3d4"}
```

`entries` is the out-of-scope section's size after the append — it only ever grows.

<!-- anchor: OUT-OF-SCOPE-NEVER-GRADUATES --> **This section is append-only and has no removal
path, by construction: no verb in this group deletes from it.** Every other section empties as fog
clears; this one is the map's memory of what was decided *against*, and an entry that can be removed
is one the next session re-proposes. Reversing a rejection is a new decision recorded under
`## Decisions` naming the entry it overturns — both stay on the record, the same shape `map record`
uses for a superseded answer.

**Its relationship to the plugin-layer `.out-of-scope/`** (skill conventions §7) is one of scope,
not duplication. That directory records what **fabrika the corpus** rejected — a proposal about the
skills themselves, durable across every repo fabrika installs into. This section records what **one
destination** rejected, and it lives on that destination's map because it is meaningless anywhere
else. Neither is a copy of the other, and a rejection belongs in exactly one: if removing the map
would make the rejection unreadable, it is a map entry; if it would survive the map, it is a
`.out-of-scope/` file.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the entry is on the map |
| `4` | the map body does not parse, or `--reason` is empty |
| `5` / `6` | the direction or reason carries a machine-local path, or is a bare `@` reference |
| `7` | the map does not exist |
| `8` / `9` | the write failed, or the read-back differs |
| `11` | a precondition read failed; nothing was written |
| `12` | the body moved since `--digest` |
| `13` | `--ticket` was given and is not a frontier ticket of this map |
| `18` | `--ticket` was given and has already left the frontier |
| `19` | this direction is already recorded out of scope on this map |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `map descope: "<direction>" is already out of scope on #<n> (<date>) — nothing was written; the recorded reasoning stands.` | 19 | refusal |
| `map descope: --reason <path> is empty — an out-of-scope entry with no reasoning is one the next session re-proposes.` | 4 | refusal |

**Scope** — the existing out-of-scope entries, ranked against `--direction` with
`src/report/dedup.ts`. Zero entries is a fact.

**The append-only fence is checked, not assumed.** The write is validated with
`src/review/append.ts`'s `appendOnly` and `grewByOne`: the section after the write must contain
every prior entry byte-identically and exactly one more. A write that would drop or mutate an
existing entry is `9`, because the read-back proves the body no longer holds what it held.

**Examples**

```
$ fabrika map descope 9140 --digest a1b2c3d4e5f6 --direction "a per-topic weight multiplier" --reason reason.md
{"map":9140,"direction":"a per-topic weight multiplier","entries":3,"digest":"e5f6a1b2c3d4"}
$ echo $?
0
```

**Grounding**

- #4644's adopt list — a never-graduating out-of-scope section is one of the four deltas this
  rebuild exists to carry. v1 has no such section: its four sections all graduate, so a rejected
  direction leaves no trace once the fog it lived in clears.
- Skill conventions §7 — the plugin-layer scope law this is the map-level twin of.

---

## Required repo files (verb-level)

The skill's own table ([SKILL.md](SKILL.md)) carries the run-level rows; these are the reads and
writes this contract's verbs make, so an implementer sees the dependency set in one place.
Vocabulary: **fail-loud** / **degrade** / **bootstrap** (front-door, #4952).

| Must exist | Why | When missing |
| --- | --- | --- |
| `gh` authenticated to `--repo` with `issues: write` | every verb reads or writes an issue, a comment or an edge over REST | **fail-loud** — `11` before any write, `8` after one; never a silent empty answer |
| The `wayfinding:map` label | `map open` applies it on mint and resumes on it | **bootstrap** (front-door, #4952); until then `map open` exits `7` naming the label |
| The native issue-dependency endpoints (`.../dependencies/blocked_by`, `.../dependencies/blocking`) enabled for the repository | `map ticket` writes the frontier's edges and `map read` derives blockedness from them | **fail-loud** — `11`. The alternative is prose topology in the body, which is the v1 shape this group replaces; degrading to it silently would rebuild the scar |
| The native sub-issue endpoint (`.../sub_issues`) | the ticket-to-map link, and the child enumeration `map read` derives the frontier from | **fail-loud** — `11`, and the frontier is UNKNOWN, never empty |
| `repos/<repo>/collaborators/<login>/permission` readable | resolves a lane claim's author (ADR 0055, `map lane`) | **fail-loud** — `11`. A permission read that fails is UNKNOWN, never a demotion that would free another run's lane |
| The `wayfinder:backlog` label | where a destination `map open` refuses with `17` or `19` parks (ADR 0210) | **degrade** — the refusal already carries the verdict and names the label it could not apply; the routing is then the caller's to place |

Nothing else. No `.decisions/`, no `.patterns/`, no CODEOWNERS, no merge-queue configuration, no
design manifest: this group opens no pull request and gates no merge.

## Completeness self-test

The six presence tests in the [interface convention Part 2](../../docs/cli-interface-convention.md)
hold: every flag has a type and a default, every stdout shape is shown by an example, every non-zero
code is enumerated with its trigger, every error names its message, stream and code, every judging
verb states its scope and zero-scope behaviour, and no clause defers to a v1 script, another skill's
prose, or the authoring session.

The five hand-checks those tests cannot perform:

1. **Every reachable outcome has a code.** Walked per verb. Three that nearly escaped: `map open`
   creating the issue and failing the label write, leaving a map no later run can find (`8`, number
   named, write order chosen so the survivor is inert); `map ticket` filing a ticket whose sub-issue
   link then fails (`8`, number named, re-run resumes); and `map record` landing the answer and
   failing the close (`8`, ordered so the surviving half is the visible-and-re-runnable one rather
   than the forbidden one).
2. **Every value an example prints is derivable from the spec.** The digest is defined as an
   algorithm over named bytes, not shown as a magic literal; `created`, `lane`, `outcome`, `state`,
   `frontier` and `kind` are closed sets enumerated above.
3. **Every literal obeys the spec's own stated formats.** Every digest literal is exactly 12
   lowercase hex; every nonce is exactly 8 lowercase hex; every JSON example parses; every issue
   number sits well above the host repository's live range so no example reads as a claim about a
   real issue.
4. **Every value a later verb needs arrives as an argument.** No clause refers to "the digest at
   read time" or "the ticket you filed": the digest is an explicit `--digest` on every body write
   and is returned by every verb that changes it, the nonce is an explicit `--nonce`, and every
   ticket and session is an explicit number. Nothing is carried in session memory, which is the
   defect v1's unassigned `$MAP`, `$E1` and `$E2` are (`wayfinder/SKILL.md:205, :561`).
5. **Every conditional output key states when it is present.** `map read`'s ticket rows are split
   into always-present and conditional, with the condition named per key.

**The shared-state law has one surface here, and it is the map body.** Every artifact this group
touches otherwise lives on GitHub keyed by issue and comment id; no verb writes a temp directory, so
the session-keyed collision recorded at #4516 cannot occur through a scratch path. The body is
guarded by `--digest` compare-and-set, and lane traffic is routed to the ticket rather than the body
precisely so a parallel burndown does not serialize on it. Stated because an absent answer to that
question reads as one nobody asked.
