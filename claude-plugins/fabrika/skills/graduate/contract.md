# `/graduate` — derived CLI contract

**Skill:** [`graduate`](SKILL.md) · **Authoring brief:** [#5103](https://github.com/kamp-us/phoenix/issues/5103) · **Date:** 2026-08-09

**Where these verbs land.** `packages/fabrika-cli/`, under a **`graduate`** subcommand group
registered in [`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts). Each leaf is
built with `leafCommand` from
[`src/excess-operand.ts`](../../../../packages/fabrika-cli/src/excess-operand.ts) so an undeclared
operand is refused rather than ignored. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill.** No verb here invokes
anything under `claude-plugins/kampus-pipeline/` or `packages/pipeline-cli/`, in a fence, behind a
wrapper, or as a contract clause (ADR
[0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every v1 module
named in a **Grounding** block below is cited as a **scar to design out**, never as a dependency —
those citations are non-normative and an implementer opens none of them to build this.

**The group name.** `graduate`, free against
[`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts) when this was written; the
registered groups were `adr build epic eval hook ledger plan report review review-ui ship spend
triage ui wire`. That list grows most weeks, so read the file rather than this sentence. Here the
group and the skill share the name, which the sibling groups do not do (`grill`/`grilling`,
`map`/`wayfinding`) — `graduate` is already a noun, and inventing a second spelling for it would
work against ADR 0246's rule that the reader resolves the homonym by **namespace**. `fabrika
graduate <verb>` is itself the namespace.

**Reading the homonym.** ADR 0246 records several live senses of the word. Two are verbs in other
CLIs and neither is reachable from here: `pipeline-cli tracker graduate` **closes** a source issue
with `state_reason=completed`, and `anka-ops flag graduate` files a flag-retirement chore. This
group's direction is the opposite of the first and unrelated to the second. Every reference to
either is written qualified, per that ADR.

## What fabrika already ships, reused — never respecified

Each is imported, not restated, because a transcription drifts and a pointer to code cannot:

- [`src/io/issues.ts`](../../../../packages/fabrika-cli/src/io/issues.ts) — `getIssue`,
  `listComments`, `createIssue`, `createComment`, `addLabels`, `listLabels`, `resolveRepo`,
  `pagedJson`. Its **`Existence<A>` = `Present | Absent | Unknown`** is what keeps a proven 404
  apart from an unreachable GitHub.
- [`src/report/leaks.ts`](../../../../packages/fabrika-cli/src/report/leaks.ts) — `scanBody`,
  `isBareAtReference`, `renderLeaks`. Pure, zero imports.
- [`src/report/dedup.ts`](../../../../packages/fabrika-cli/src/report/dedup.ts) — `tokenize`,
  `scoreTitle`, `rank`, `TOKEN_FLOOR`. Used by no verb in this group; named because the **skill**
  invokes `fabrika report dedup` directly at its step 3. A `graduate dedup` wrapper relaying that
  answer is what ADR 0238 forbids, so there is none.
- [`src/report/compose.ts`](../../../../packages/fabrika-cli/src/report/compose.ts) —
  `normalizeForReadback`. Read-backs compare normalized, never byte-identical.
- [`src/verb.ts`](../../../../packages/fabrika-cli/src/verb.ts) `answer` / `refuse`, and the `emit`
  adapter each group copies.

**`renderFooter` is NOT reused, and the reason is a shape mismatch rather than a preference.** Its
`FooterFields` is `{session, model, branch, timestamp}` and it renders `Filed by an agent · …`; it
carries no field for the source issue or the spec digest, which are the two things this group's
footer exists to record. This group specifies its own footer renderer below, with byte-exact output
because the read-back at `9` compares against it.

**The two sibling resolvers this group imports, and why importing beats re-parsing.**

- `src/grill/` — the `grill read` resolver: the four ruling clauses, the ACL resolution, the
  digest comparison, and the closed `state` set (`open`, `answered`, `ruled`, `unattested`,
  `stale`, `superseded`), specified at [`../grilling/contract.md`](../grilling/contract.md).
- `src/map/` — **two** pieces, and the distinction is load-bearing: the **body parser**, which
  parses the map's five sections including `## Decisions`, and the per-ticket state resolution
  (`open`, `lane-held`, `lane-closed`, `forked`, `graduated`, `retired`). Both specified at
  [`../wayfinding/contract.md`](../wayfinding/contract.md).

<!-- anchor: MAP-DECISIONS-COME-FROM-THE-BODY --> **A map's decisions come from its `## Decisions`
section, not from its ticket states**, and this group depends on the map **module**, not on `map
read`'s stdout. `map read`'s output object returns `tickets[]`, `outOfScope[]`, `counts` and the
frontier token but **no array of the map's `## Decisions` entries** — so a design that read this
group's decisions off that JSON could not produce a `ruled` row at all, and every founder ruling
recorded on a map would render as an agent's finding, which is precisely the #4227 failure this
skill exists to prevent. The body parser does parse that section (the five-section floor is what
`map read` validates), so the entries are available to an importer even though the verb does not
surface them. Stated explicitly because the difference between *importing a module* and *consuming
a sibling verb's stdout* is invisible until it produces a wrong provenance.

**Each map `## Decisions` entry carries its own authority citation**, which is what makes the
provenance derivable rather than guessed: `— ruled on #<session> <question-id>` for a founder ruling
relayed from a `grilling` session, and `— from #<ticket>` for a research finding. An entry with
neither is malformed by that contract's own rule and is reported, never defaulted.

`graduate trail` **calls those resolvers rather than parsing either artifact itself.** This is the
load-bearing reuse decision on the page, so here is the argument. Whether a question is `ruled` is
already answered by a verb whose whole design is answering it fail-closed against the ACL; a second
parser here would be a second answer to a question already decided elsewhere — the exact shape ADR
0238's "some become nothing" clause names — and the two could disagree, which on this question means
one of them licenses synthesizing over an unproven ruling. Importing makes disagreement
unrepresentable rather than merely unlikely.

**Sequencing dependency, stated because it is real.** Those two modules do not exist yet:
`grilling`'s verbs are held at [#5023](https://github.com/kamp-us/phoenix/issues/5023) and
`wayfinding`'s at [#5022](https://github.com/kamp-us/phoenix/issues/5022). This group cannot be
implemented before both land. That ordering belongs in this group's implementation ticket, and
nothing here should be read as describing present behaviour.

**Read for its shape, NOT imported.**
[`src/report/file-verb.ts`](../../../../packages/fabrika-cli/src/report/file-verb.ts) is the model
for the whole-transaction shape — local checks before any network call, leak scan *after*
composition so appended bytes cannot escape, read-back before success. **Neither its verb nor its
read-back helper can be called here**, and both blockers are the same `REQUIRED_SECTIONS` fact
wearing two hats: `runFile` validates the body against
[`src/report/compose.ts`](../../../../packages/fabrika-cli/src/report/compose.ts)'s six intake
headings, and `readbackMismatch` re-asserts those same six headings on the landed issue *and*
asserts report's own `Filed by an agent` footer marker — which this group's footer deliberately does
not carry. Importing it would refuse every spec this group files, twice over. So this group owns its
section constant, its orchestration, and its own read-back assertions, spelled out below.

**This group's read-back, stated because it is not inherited.** After the create, `graduate emit`
re-reads the issue and asserts all four, comparing with `normalizeForReadback` rather than byte-for-
byte: the body carries the four spec headings in order; the body ends with this group's footer line;
the title equals `--title` as given; and the label set is **exactly** `["status:needs-triage"]`. Any
miss is `9`.

<!-- anchor: REPORT-SECTIONS-NOT-WIDENED --> **`report`'s `REQUIRED_SECTIONS` is deliberately NOT
widened**, and the distinction matters because ADR 0246 says this skill "files through the existing
report verb machinery". That reads as the **modules** — the leak predicate, the footer, the
read-back normalizer, the dedup core — not the `report file` verb. Widening the intake constant
would change what every *intake* filing in the repo requires, to serve one caller that is not
intake. The duplication is one section list; the alternative is a shared constant with two
incompatible meanings.

## Considered and deliberately not derived

- **A `graduate dedup` verb.** Its only behaviour would be relaying what `fabrika report dedup`
  already computes. The skill calls that verb directly (`SKILL.md` §3).
- **A verb that decides what the spec says.** Composing the problem and the solution from a decision
  trail is the judgment the wrapper exists to carry. A verb doing it would be a stochastic answer
  wearing a deterministic exit code.
- **A verb that decides whether a trail warrants more than one spec issue.** Same reason. The verb
  enforces *one issue per invocation* mechanically (`graduate emit`, and the digest refusal at `15`);
  which decisions form one coherent spec is the skill's, and `SKILL.md` §2 states what to do with
  the remainder.
- **A verb that closes or annotates the source.** Emission does not retire the thing it read.
  `grilling` and `wayfinding` own their own artifacts, and `wayfinding`'s contract already drops
  both branches of map-closing on the ground that emission is this skill's. Closing a source is
  `pipeline-cli tracker graduate`, in another CLI, and rebuilding it here would re-derive the
  destructive half v1 scripted while leaving the safe half as prose.
- **A verb that writes a `type:`, priority or milestone label.** Ruled out by ADR 0246 and enforced
  at `10`: triage is the sole authority and this group computes no second answer to it.
- **A merge-gating verdict.** `graduate` is deliberately absent from `SHIP_NAMESPACES`
  ([`src/review/classes.ts`](../../../../packages/fabrika-cli/src/review/classes.ts):161) and emits
  no verdict marker, so `wire/verdict-marker.ts`'s `NAMESPACE` regex (`:73`) and its **separate**
  `NAMESPACE_PREFIXES` gate (`:78`) are **not** widened, and neither is
  [`src/review/advisory.ts`](../../../../packages/fabrika-cli/src/review/advisory.ts)'s `FIRST_LINE`
  (`:20`). Nothing recorded here can block a merge; widening any of them would create the second
  human gate [#4631](https://github.com/kamp-us/phoenix/issues/4631) rules out.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `graduate trail` | resolve the source through its sibling reader and normalize it into one provenance-tagged decision trail, with a readiness token and a trail digest | the label dispatch, the provenance mapping and the digest are total functions of the resolver's output; *what the decisions mean* is the skill's |
| `graduate compose` | render the four-section spec body, owning the `## Decisions` section entirely | the section floor, the rendering of decisions from the trail and the leak scan are mechanical; the three authored sections are judgment |
| `graduate emit` | file the one spec issue, apply the single label, read it back, and record the emission on the source | a guarded create plus a bound marker write; the repeat refusal is a total function of the source's markers and the spec body's ref list |
| `graduate read` | the reader — has this source already graduated, and into what | a total three-valued marker read; nothing here is judgment |

## The spec body this group WRITES

Four sections, in this order, and nothing else:

```markdown
## Problem
Moderation weight is unbounded, so one vouched account can outvote a whole topic.

## Solution
Weight is earned per account and capped per topic; the vote table carries the cap.

## Decisions
- Weight is earned per account, never inherited from a kefil. — **ruled** · R2.3
- The vote table has no per-account weight column today. — **established** · R2.1

## Out of scope
Weight decay on a clock — no decision yet, still open on #9412.
```

- `## Problem`, `## Solution` and `## Out of scope` arrive on **stdin**, authored by the caller. A
  missing, empty or out-of-order section among the three is `4`.
- `## Decisions` is **rendered by `graduate compose` from the trail** and never read from stdin. A
  stdin body carrying a `## Decisions` heading is `17`.

<!-- anchor: DECISIONS-ARE-RENDERED-NOT-AUTHORED --> **Why the verb owns that one section.** The
brief's central acceptance criterion is that a downstream reader can tell the founder's decisions
from the skill's synthesis without the source transcript (#4227). A convention telling the model to
label them would be exactly the kind of prose invariant that holds until the run that forgets. Here
the separation is structural: the provenance word and the source id are rendered from resolver
output the model never touches, so a mislabelled decision is not something an agent can produce by
being careless. The three sections the model *does* author carry no authority claims at all.

**Each `## Decisions` entry is `- <text> — **<provenance>** · <ref>`**, where `ref` is the trail
row's own `ref` field verbatim and `provenance` is from a closed set of two. The source issue is
**not** repeated per line — it is in the footer once, and repeating it made a map-sourced line read
as two issue numbers in a row (`· #9502 #9505`).

<!-- anchor: THE-DECISIONS-LINE-IS-PARSEABLE-BACK --> **The line is written so `graduate emit` can
recover the ref from it**, which matters because that parse is what says which subset a spec covers.
The rule is exact: a decision line matches `^- (?P<text>.+) — \*\*(?P<provenance>ruled|established)\*\* · (?P<ref>.+)$`,
and `ref` is everything after the **last** ` · ` that follows the bolded provenance token. Anchoring
on the bolded token — a closed two-member set — is what keeps the parse unambiguous when the text
itself contains an em dash or a `·`, and it lets a ref carry a space and a `#` (`#9301 R1.2`)
without quoting. A line in the `## Decisions` section that does not match is `18`: the section is
machine-rendered at both ends, so a line that will not parse means the body was edited by hand.

**`ref` is shaped by the source kind**, and a reader tells them apart by shape alone:

| Source | `ref` shape | Example |
|---|---|---|
| `grilling` | `R<round>.<n>` — the question id | `R2.3` |
| `map`, from a graduated ticket | `#<ticket>` | `#9505` |
| `map`, from a `## Decisions` line relaying a session ruling | `#<session> <question-id>` | `#9301 R1.2` |

The provenance words:

| Word | Means | Resolved from |
|---|---|---|
| `ruled` | the founder decided it, proven at the ACL with a dated authorization beside it | a `grilling` question whose state is `ruled`; a map `## Decisions` entry citing `— ruled on #<session> <id>` |
| `established` | an agent answered a question of fact and recorded the evidence | a `grilling` question whose state is `answered`; a map ticket whose state is `graduated` |

There is no third word, and in particular there is no word for *inferred*. A decision nobody ruled
and nobody established is not on the trail — it is an open question, and it makes the trail
`blocked` (see `graduate trail`).

**The footer** is appended by `graduate emit` — never by `compose` — after the sections and a blank
line, in this exact shape, one line, newline-terminated:

```
<sub>Filed by an agent · graduated from #9412 · spec a1b2c3d4e5f6 · 2026-08-09T18:36:48Z</sub>
```

<!-- anchor: FILED-BY-AN-AGENT-IS-NEVER-DROPPED --> **`Filed by an agent` leads the line and is not
this group's to omit.** It is ADR 0159's never-auto-close signal
([`src/report/compose.ts`](../../../../packages/fabrika-cli/src/report/compose.ts):92), and
[`src/triage/provenance.ts`](../../../../packages/fabrika-cli/src/triage/provenance.ts) classifies a
body by whether a line begins with `<sub>Filed by an agent` — so a spec filed without it is read as
**human-authored** and loses the signal. An earlier draft of this contract dropped the marker while
extending the footer with a source and a digest, which was a regression in the one field nothing
here justified touching. This group **extends** the shipped shape; it does not replace it.

`#<source>` is the issue the trail was read from, `spec <digest>` is the 12-hex spec digest, and the
timestamp is ISO-8601 UTC. The bytes are fixed here because the read-back at `9` compares them.

## The emission marker

One new `wire` format, `graduate-emitted`, first line of its own comment on the **source** issue:

```
graduate-emitted: #9412 → #9520 @ a1b2c3d4e5f6 · covers R1.2;R1.4;R1.1;R1.3 · 2026-08-09T18:36:48Z
```

| Field | Shape |
|---|---|
| source | `#<n>` — the issue the trail was read from |
| emitted | `#<n>` — the spec issue this run filed |
| digest | exactly 12 lowercase hex characters — the **spec** digest defined below |
| covers | the refs this spec rendered, in trail order, separated by `;` |
| timestamp | ISO-8601 UTC, `Z`-suffixed |

<!-- anchor: THE-MARKER-CARRIES-ITS-REFS --> **`covers` is what lets `graduate read` answer a
coverage question without re-deriving anything.** A digest alone is opaque: a reader holding one
cannot say which parts of a trail are specified. The alternatives were to have `read` re-derive the
trail — which costs it its split test, since it would stop being a total marker read and start
making the judgment `trail` already makes — or to admit coverage is underivable, which leaves a
caller unable to tell a remainder from a duplicate. Putting the refs in the marker keeps `read` pure
and makes the question answerable from the artifact.

**The separator is `;`, not `,`, because a map ref contains a space** (`#9301 R1.2`), so a
comma-separated list of them is ambiguous. No ref shape defined above can contain a `;`.

**Read is total and three-valued**, on the
[`src/wire/verdict-marker.ts`](../../../../packages/fabrika-cli/src/wire/verdict-marker.ts) model:
`Found` (all fields parse), `Malformed` (the key is present and a field does not parse), `Absent`
(no such key). **A malformed marker is never silently `Absent`** — `graduate read` reports it as a
`disregarded` row at exit `0`, so an emission that really happened but was written in a shape the
parser cannot see is a *visible* state rather than an invisible one. Treating it as `Absent` would
let `graduate emit` file a second spec for a trail already graduated, which is the one outcome the
digest refusal exists to prevent.

**Why a new format rather than widening `verdict-marker`'s `NAMESPACE`.** That regex (`:73`) is
guarded by a separate prefix gate that runs before it is ever tested (`:78`), and a non-member
returns `Absent` rather than `Malformed` — so a widening that missed either constant would emit
markers it can never read back, the hazard that file's own docblock names. An emission is also not a
verdict: it carries no `PASS`/`FAIL` polarity and binds a spec digest rather than a head SHA.

<!-- anchor: WIRE-FORMAT-COST --> **What the new format costs**, stated in full because a short
version of this list has been wrong in a sibling draft. It needs, and CI reds without:

1. a sibling schema module beside the shipped formats;
2. one row in [`src/wire/registry.ts`](../../../../packages/fabrika-cli/src/wire/registry.ts)
   `registeredFormats`;
3. a rendered projection row **plus its own `### graduate-emitted` prose section** in
   [`../../docs/wire-formats.md`](../../docs/wire-formats.md) — `src/wire/index-doc.unit.test.ts`
   asserts the committed doc reconciles against `registeredFormats` with zero findings, that the
   documented key set **equals** the registry's, and that the doc contains
   `renderProjection(registeredFormats)` verbatim;
4. the payload `WireFormat` (`src/wire/format.ts`) makes required: a `roundTrip` fixture pair, an
   `absent` sample, a **non-empty** `malformed[]` array with a `drift` label per entry, and a
   non-empty `brandWitnesses` set.

**Stated, not yet enforced.** All of it lands with the implementation. Until then nothing in the
shipped package recognizes the key, and no claim on this page describes present behaviour.

## The two digests, and the neutrality invariant

**One algorithm, two scopes.** The digest of a set of decision entries is the first 12 characters of
the lowercase hex SHA-256 of, for each entry in trail order, its `ref`, its `provenance` word and its
`text`, joined by `\n`, LF-normalized, with trailing whitespace stripped per line.

| Name | Scope | Who computes it |
|---|---|---|
| **trail digest** | **every** decision on the trail | `graduate trail`, printed as `trailDigest` |
| **spec digest** | only the decisions **rendered into the filed spec** | `graduate emit` alone — re-derived from the refs in the body it was handed. `compose` neither computes nor prints it; its answer is the four sections and no footer |

When a spec carries the whole trail the two are **equal by construction**, because the algorithm and
the entry order are the same and the sets are the same.

<!-- anchor: THE-MARKER-BINDS-THE-SPEC-NOT-THE-TRAIL --> **The emission marker binds the SPEC digest,
and that is what keeps a remainder reachable.** An earlier revision bound the trail digest, and a
graded eval run found the consequence three review passes had missed: `SKILL.md` §2 tells a caller
whose trail spans two buildable things to file the coherent whole and name the remainder in
`## Out of scope` — but if the marker bound the *trail*, the `15` refusal would then reject a second
run over that remainder forever. The mechanism guaranteeing one-issue-per-invocation would be the
same mechanism stranding every leftover, and `graduate` could never finish a trail it deliberately
split. Binding the rendered subset instead means a remainder graduates as its own spec at its own
digest, while a genuine duplicate of the same decision set is still refused.

Two specs from one trail may overlap partially; their digests differ, so both are admitted. That is
deliberate — refusing a partial overlap would strand the remainder again, one step further out.

<!-- anchor: DIGEST-NEUTRALITY --> **Named invariant — both digests are neutral to every write this
group makes.** The digested bytes are decision triples exactly as the resolver returned them, never
a byte this group writes: no comment, no marker, no label, no issue metadata and no rendered issue
text. The spec digest's *scope* is chosen by which refs were rendered; its *content* still comes
from the resolver, which is why a forged body cannot forge a digest. It must be, because the digest is what `graduate emit` binds its marker to *and* what
the next run compares against: a digest covering the source's comments would be changed by the
marker comment `graduate emit` itself posts, so the very act of recording an emission would make the
recorded digest un-reproducible, and every re-run would read a trail as fresh and file a second
spec. The three writes this group performs — the spec issue, its label, the marker comment — all sit
outside the digested bytes by construction.

It is also neutral to the sources' own later writes in the direction that matters: a new `grilling`
round or a new frontier ticket adds decisions and *changes* the digest, which is correct — that is a
different trail and a different spec. What must not change it is anything **graduate** does.

The implementation owes a deterministic test that recomputing a trail's digest yields the
byte-identical value it yielded before `graduate emit`, run **after** the marker comment lands.

## Shared conventions

Every `graduate` verb obeys these; stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else, except
  `graduate compose`, whose answer is the composed markdown body and which declares that in its own
  block. Scope lines, refusal reasons and progress go to stderr. **A non-zero exit prints nothing on
  stdout** — the shipped `refuse` helper hardcodes empty stdout
  ([`src/verb.ts`](../../../../packages/fabrika-cli/src/verb.ts):51-55), so a partial answer beside a
  failure code is not constructible here and must not be specified.
- **A proven outcome is a state word at exit `0`, never a non-zero code.** `graduate trail`'s
  readiness token is the worked case: `ready`, `blocked` and `empty` are three answers and **all
  three exit `0`**. A trail holding an unresolved decision is this skill working, and seating it on
  a non-zero code would make a caller's `[ $? -ne 0 ]` read "the founder has not decided yet" as
  "the verb never ran".
- **A 404 is a verdict; anything else is UNKNOWN.** A missing source issue is `7`. An unreachable or
  erroring GitHub is `11` before any write and `8` after one.
- **Widening stated — `7` covers a missing READ target here, not only a write target.** The base
  seats `7 NO_TARGET` as *the write target does not exist* (`--label` in the repo, or `--issue`),
  and `graduate emit` uses it in exactly that sense. `graduate trail` and `graduate read` write
  nothing at all, and they seat `7` on a source issue that does not exist. The widening is from
  *write target* to *named target*: in every case `7` still means **the thing this invocation named
  is proven absent**, which is what a caller branches on, and it stays distinct from `11` (the read
  could not complete) and from `12` (the target exists but is not a trail surface). Stated because
  an undeclared re-meaning of an imported constant is the drift the import exists to stop.
- **Common inputs.** `--repo <owner/name>` (default: resolved from the `origin` remote) on every
  verb. There is no `--json` flag: the answer channel is already one JSON object.
- **GitHub access follows [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)**,
  paginated. The reason lives there. Local to this group: a source with more than one page of
  comments is ordinary after a few rounds, so an unpaginated read would miss an emission marker and
  file a second spec — the fail-open direction.
- **Every text this group sends to GitHub is leak-scanned** with `src/report/leaks.ts` before the
  write — the composed body **and** the `--title`. A machine-local path is `5`, a bare `@` reference
  is `6`. **Widening stated:** the base's `5` reads *"…and `--redact` was not given"*; no `graduate`
  verb offers `--redact`, so here `5` fires unconditionally. A spec issue is a durable artifact and
  a redacted path in one is a path nobody can act on; the caller edits the body instead.
- **Every write is read back** and compared with `normalizeForReadback`; a mismatch is `9`.
- **Error messages are prefixed with the invoked verb's name** — `graduate emit: …`.

### The shared exit matrix

This table owns `code → meaning`. Per-verb **Errors** tables below own only that verb's own
triggers. `0`, `1`, `126` and `127` are stated **here and only here**, and every verb can return them.

| Code | Meaning | `trail` | `compose` | `emit` | `read` |
|---|---|---|---|---|---|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ |
| `3` | `EMPTY_STDIN` — stdin was read and held nothing | — | ✓ | — | — |
| `4` | `BAD_SECTIONS` — an authored section is missing, out of order, or empty; or (on `trail`) the map body does not parse | ✓ | ✓ | ✓ | — |
| `5` | `LEAKED_PATH` — the text carries a machine-local path | — | ✓ | ✓ | — |
| `6` | `BARE_AT_PATH` — the text is a bare `@` path reference | — | ✓ | ✓ | — |
| `7` | `NO_TARGET` — the named target does not exist: the source issue (`trail`, `read`, `emit`), or the `status:needs-triage` label (`emit` only) | ✓ | — | ✓ | ✓ |
| `8` | `WRITE_UNKNOWN` — the write failed, so the outcome is UNKNOWN | — | — | ✓ | — |
| `9` | `READBACK_MISMATCH` — the write landed, the read-back differs | — | — | ✓ | — |
| `10` | `CLASSIFIED` — the `--title` carries a type or priority classification | — | — | ✓ | — |
| `11` | `PRECONDITION_UNKNOWN` — a precondition read failed; nothing written | ✓ | ✓ | ✓ | ✓ |
| `12` | `SOURCE_UNRECOGNIZED` — the issue carries neither source label | ✓ | — | ✓ | ✓ |
| `13` | `TRAIL_BLOCKED` — the trail holds an unresolved decision | — | ✓ | ✓ | — |
| `14` | `DIGEST_UNBINDABLE` — a decision entry is missing a digested field (`ref`, `provenance` or `text`), or `--trail` carries no 12-hex digest | — | ✓ | ✓ | — |
| `15` | `ALREADY_GRADUATED` — this **spec** digest already emitted an issue | — | — | ✓ | — |
| `16` | `TRAIL_EMPTY` — the trail holds zero decisions | — | ✓ | ✓ | — |
| `17` | `DECISIONS_AUTHORED` — the stdin body carries a `## Decisions` heading | — | ✓ | — | — |
| `18` | `DECISIONS_STALE` — a ref the spec carries is absent from the re-derived trail, or its provenance or text has changed; or a `## Decisions` line does not parse | — | — | ✓ | — |

**`3`–`11` are imported from
[`src/report/codes.ts`](../../../../packages/fabrika-cli/src/report/codes.ts)**, not restated as
numerals, so a drift is unrepresentable rather than merely detectable. `12`–`18` are the group's own
and clear the base's occupied seats; they carry **no** cross-group uniqueness obligation, so
`review`'s `12` and this group's `12` are two namespaces rather than a collision.

**`10` is reachable here and is load-bearing, not a courtesy.** ADR 0246 forbids this skill writing
board state, and `10` is that prohibition made mechanical: the base seats it for a title or label
carrying a type or priority, which is exactly the thing a well-meaning run would add to a spec issue
to "help triage". There is no deliberate gap in this group's table.

#### Terminal seating — which code lands on which §TERM terminal

The closed set of terminal names is the skill's ([`SKILL.md`](SKILL.md) §TERM); the seating is this
matrix's, because it is a total function of the code. Every **non-zero** code seats on exactly one
terminal.

| Terminal | Codes | What it means for the run |
|---|---|---|
| `TRAIL-READ` | `0` from `graduate trail` readiness `ready`; `0` from `graduate read` when **no existing emission covers the subset about to be filed** — whether that is `ungraduated`, or `graduated` with `covers` naming only other refs | a read completed and nothing blocks synthesis |
| `TRAIL-BLOCKED` | `0` from `graduate trail` readiness `blocked`; `13` | an unresolved decision remains — the seam working. Name it and stop |
| `TRAIL-EMPTY` | `0` from `graduate trail` readiness `empty`; `16` | there is nothing to synthesize yet |
| `SPEC-COMPOSED` | `0` from `graduate compose` | a body exists and nothing has been filed |
| `SPEC-FILED` | `0` from `graduate emit` | one spec issue exists at `status:needs-triage`; the lane ends |
| `ALREADY-GRADUATED` | `0` from `graduate read` when an existing emission's `covers` **already includes the subset about to be filed**; `15` | that spec already exists. Report its number; this is a success |
| `NOTE-ADDED` | **no `graduate` code** — `0` from the sibling `fabrika report note` | step 3 found the same spec already filed and added what it lacked. A write happened, so this is not `STOPPED`; no spec was filed, so it is not `SPEC-FILED`. Listed here because a terminal reachable from the skill and seated on no code of this group would otherwise read as an omission |
| `SOURCE-UNRESOLVED` | `7`, `12` | the source could not be named — absent, or carrying neither source label. Nothing was written |
| `INPUT-REFUSED` | `3`, `4`, `5`, `6`, `10`, `17`, `18` | an input the caller supplied is **proven** malformed and nothing was written. Fix and re-run; this is not UNKNOWN |
| `WRITE-UNPROVEN` | `8`, `9` | a write may or may not have landed. Re-read before re-writing |
| `STOPPED` | `1`, `11`, `14`, `126`, `127` | the run is UNKNOWN with nothing written |

`0` is disambiguated by which verb produced it and, for `graduate trail`, by the `readiness` token.

<!-- anchor: GRADUATED-IS-NOT-A-TERMINAL-BY-ITSELF --> **`state: graduated` alone does not seat a
terminal, and that is deliberate.** It goes true as soon as *anything* has been filed from the
source, so seating it directly on `ALREADY-GRADUATED` would stop every second run over a
deliberately split trail — the stranded remainder, reappearing at the terminal layer after being
designed out of the digest layer. The seat turns on `covers`, not on `state`.

**Registration burden the implementer inherits — four distinct edits, none implied by the others.**

1. `src/registry.ts` — add `graduateCommand` to `registeredGroups`. Alphabetical order is the
   `--help` order, so it sorts after `eval` and before `hook`.
2. `src/exit-code-alignment.ts` — add `graduate` to `ALIGNED_GROUPS`. Its value is a `SharedSeats`
   map keyed by this group's own export names, and **none of the five shipped maps fits**: this
   group seats `4` as `BAD_SECTIONS` (so `BUILD_SEATS` is closest) but names `7` `NO_TARGET` and
   `10` `CLASSIFIED` with no `ZERO_SCOPE`/`OFF_VOCABULARY` aliases. A new `GRADUATE_SEATS` constant
   is authored in that same file.
3. `src/exit-code-alignment.unit.test.ts` — add the `graduate` import and its row to the
   hand-written `TABLES` map, or the on-disk-versus-registered coverage assertion reds the moment
   `src/graduate/codes.ts` exists.
4. The `graduate-emitted` wire format, with the full four-part cost above — including its own
   `wire-formats.md` section, without which `src/wire/index-doc.unit.test.ts` reds.

---

## `graduate trail`

**Invocation**

```
fabrika graduate trail 9412 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<source>` | positional integer | yes | — | the `grilling` session or `wayfinding` map issue to read the trail from |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the source lives in |

**Behaviour.** Reads the source's labels and dispatches: `grilling:session` resolves through the
`grill read` resolver, `wayfinding:map` through the `map read` resolver, and neither is `12`. An
issue carrying **both** labels is also `12`, naming both — that is a mis-shaped artifact rather than
a merge of two trails, and guessing which one is live would be judgment inside a verb.

**Output** — machine. One JSON object; every key below is always present:

```json
{"source":9412,"kind":"grilling","readiness":"ready","trailDigest":"a1b2c3d4e5f6","decisions":[{"ref":"R2.3","provenance":"ruled","text":"Weight is earned per account, never inherited from a kefil."},{"ref":"R2.1","provenance":"established","text":"The vote table has no per-account weight column today."}],"unresolved":[],"outOfScope":[],"counts":{"ruled":1,"established":1,"unresolved":0}}
```

| Key | Type | Meaning |
|---|---|---|
| `source` | integer | the source issue number |
| `kind` | string | closed set — `grilling` or `map` |
| `readiness` | string | closed set — `ready`, `blocked`, `empty` |
| `trailDigest` | string | the 12-hex trail digest |
| `decisions` | array | one object per resolved decision, in trail order, each with `ref`, `provenance` and `text` |
| `unresolved` | array | one object per decision still open, each with `ref` and `state` — the resolver's own state word, verbatim |
| `outOfScope` | array | for a map source, the `outOfScope` entries the resolver returned, each with `direction`, `reason` and `recordedAt`; always `[]` for a `grilling` source, which has no such section |
| `counts` | object | `ruled`, `established` and `unresolved` |

**How `readiness` is computed**, in this order:

1. `blocked` when `unresolved` is non-empty.
2. `empty` when `unresolved` is empty and `decisions` is empty.
3. `ready` otherwise.

<!-- anchor: READINESS-IS-NOT-THE-FRONTIER-TOKEN --> **`readiness` is not a relay of the sibling's
`frontier` token**, and the difference is the reason this key exists. `frontier: clear` on a map
means every ticket is `graduated` or `retired` — a map whose every ticket was *retired* into the
out-of-scope section reads `clear` and carries **nothing to synthesize**, which is `empty` here, not
`ready`. The tokens also differ in arity and vocabulary: a map's `awaiting-founder` / `lanes-pending` and a
session's `awaiting-founder` / `facts-pending` all collapse to `blocked` here, because this verb
does not care *who* owes the answer, only whether one is outstanding. Mapping one onto the other would file an empty spec on a fully-descoped
map.

**Which resolver states map to what:**

For a `grilling` source, every row comes from a question's resolved state. For a `map` source,
`decisions` come from the map's **`## Decisions` section** and `unresolved` comes from its
**ticket states** — two different parts of the artifact, which is why the map rows below name a
source part rather than a state word alone.

| Source | Read from | Here |
|---|---|---|
| `grilling` | question state `ruled` | a `decisions` entry, provenance `ruled`, `ref` = the question id, `text` = the question's decided text |
| `grilling` | question state `answered` | a `decisions` entry, provenance `established`, `ref` = the question id |
| `grilling` | question state `open`, `unattested`, `stale` | an `unresolved` entry carrying that word |
| `grilling` | question state `superseded` | omitted entirely — a retired question is neither a decision nor an open one |
| `map` | a `## Decisions` entry citing `— ruled on #<session> <id>` | a `decisions` entry, provenance `ruled`, `ref` = `#<session> <id>`, `text` = the entry's prose with the citation stripped |
| `map` | a `## Decisions` entry citing `— from #<ticket>` | a `decisions` entry, provenance `established`, `ref` = `#<ticket>`, `text` = the entry's prose with the citation stripped |
| `map` | a `## Decisions` entry citing neither | **unreachable here** — the imported parser refuses the body first; see below |
| `map` | ticket state `open`, `lane-held`, `lane-closed`, `forked` | an `unresolved` entry carrying that word |
| `map` | ticket state `graduated` | omitted — its answer is already a `## Decisions` entry, and counting both would double it |
| `map` | ticket state `retired` | omitted from `decisions`; the section's own entries appear in `outOfScope` |

**`text` excludes the citation**, on both map rows, because the citation is rendered separately as
`ref` — leaving it in would print the authority twice and, worse, would fold it into the digest
where a later re-citation would read as a changed decision.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `graduate trail: #<n> does not exist.` | 7 | refusal |
| `graduate trail: #<n> carries neither grilling:session nor wayfinding:map — there is no trail to read.` | 12 | refusal |
| `graduate trail: #<n> carries both grilling:session and wayfinding:map — refusing to guess which trail is live.` | 12 | refusal |
| `graduate trail: #<n>'s map body does not parse into the five sections, or holds a ## Decisions entry citing neither an authority nor a ticket — this is proven malformed, not unknown. Fix the map and re-run.` | 4 | refusal |
| `graduate trail: cannot read #<n>: <reason> — the trail is UNKNOWN, never empty and never ready.` | 11 | refusal |
| `graduate trail: the resolver could not resolve <login>'s permission: <reason> — a ruling's authority is UNKNOWN, never granted.` | 11 | refusal |

**Scope** — the source issue, its labels, and everything the dispatched resolver scans (for a
`grilling` source: every comment, paginated, plus one ACL read per marker author; for a `map`
source: every child, both edge lists per child, and every comment, all paginated). The scope line on
stderr names the source kind and the counts the resolver reported, because `readiness` is only
readable against them. **Zero decisions is a fact** (`empty`); a read that could not complete is
`11`, never an empty trail.

**Examples**

```
$ fabrika graduate trail 9412
{"source":9412,"kind":"grilling","readiness":"blocked","trailDigest":"4e2f8a0b6c13","decisions":[{"ref":"R2.1","provenance":"established","text":"The vote table has no per-account weight column today."}],"unresolved":[{"ref":"R2.2","state":"open"}],"outOfScope":[],"counts":{"ruled":0,"established":1,"unresolved":1}}
$ echo $?
0
```

```
$ fabrika graduate trail 9999
graduate trail: #9999 does not exist.
$ echo $?
7
```

**Grounding**

- ADR 0092 — a read that could not complete never answers "no decisions".
- `pipeline-cli wayfinder-map` reports a malformed map and **returns normally**
  (`wayfinder-map/command.ts:76-79`), so a caller keying on exit status reads a broken map as fine.
  Here a source that cannot be read is `11` and a resolved one is `0`, and the readiness word rather
  than the status carries the answer.
- The same tool's `DANGLING_FRONTIER_REF` self-disables on an empty sub-issue read
  (`validate.ts:130`, `if (subIssues.length > 0)`) — the zero-scope pass ADR 0092 forbids. Here an
  empty read that cannot be proven empty is `11`.
- #4060 — a classifier read zero files under parallel invocation and silently defaulted to a
  plausible answer. `readiness` is never defaulted: it is computed from a resolver result or the
  verb refuses.
- #4227 — a well-formed but wrong classification propagating downstream unchallenged. `provenance`
  is resolved from the sibling's ACL-proven state and never from prose, and `unresolved` carries the
  resolver's own word rather than a re-interpretation of it.

---

## `graduate compose`

**Invocation**

```
fabrika graduate compose --trail trail.json
```

Reads the three authored sections from **stdin**. An example a caller can paste verbatim:

```
fabrika graduate compose --trail trail.json <<'SPEC'
## Problem
Moderation weight is unbounded, so one vouched account can outvote a whole topic.

## Solution
Weight is earned per account and capped per topic; the vote table carries the cap.

## Out of scope
Weight decay on a clock — no decision yet, still open on #9412.
SPEC
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--trail` | path | yes | — | a file holding the exact JSON object `graduate trail` printed; its `decisions` render the `## Decisions` section |
| `--decisions` | string, **repeatable** | no | every decision on the trail | one ref this spec covers, given once per ref. The rendered subset is what the spec digest is taken over, so a remainder can graduate later as its own spec |
| stdin | markdown | yes | — | the three authored sections — `## Problem`, `## Solution`, `## Out of scope` — in that order |

<!-- anchor: DECISIONS-IS-REPEATABLE-NOT-COMMA-SEPARATED --> **`--decisions` is repeated, not
comma-joined**, because a map ref contains a space (`#9301 R1.2`) and a comma-separated list of such
refs cannot be split unambiguously. `--decisions "#9301 R1.2" --decisions "#9507"` is the shape; a
single comma-joined value is a usage error at `1`.

**Output** — **machine channel**, with a shape that differs from the group default: stdout is the
composed markdown body, byte-exact, ready to pass to `graduate emit --spec`. It is machine and not
prose under rule 2's own test — the bytes are *fed to another command*, not grepped for a state
word — and the fixed four-section document is the declared shape. It is not JSON, nothing else
lands on stdout, and there is no empty answer: a body that cannot be composed is a refusal.

**Behaviour.** Validates the three authored sections against the floor, refuses a `## Decisions`
heading on stdin (`17`), renders `## Decisions` from `--trail`'s `decisions` array in trail order,
splices it between `## Solution` and `## Out of scope`, and leak-scans the whole composed body
**after** splicing so rendered bytes cannot escape the scan. Refuses on a `blocked` (`13`) or
`empty` (`16`) trail, so a spec can never be composed over an unmade decision even if the caller
skipped the skill's own step 2.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `graduate compose: stdin was read and held nothing — refusing to compose a spec with no authored sections.` | 3 | refusal |
| `graduate compose: section "<heading>" is missing.` | 4 | refusal |
| `graduate compose: section "<heading>" is empty.` | 4 | refusal |
| `graduate compose: sections are out of order — "<heading>" follows "<heading>".` | 4 | refusal |
| `graduate compose: the body carries a machine-local path: <path> — refusing to compose it into a spec.` | 5 | refusal |
| `graduate compose: the body is a bare @ path reference — not redactable, refusing to compose it.` | 6 | refusal |
| `graduate compose: cannot read --trail <path>: <reason> — nothing was composed.` | 11 | refusal |
| `graduate compose: --trail <path> reports readiness "blocked" — <n> decision(s) unresolved: <refs>. Refusing to synthesize a spec over a decision nobody made.` | 13 | refusal |
| `graduate compose: --trail <path> does not carry a 12-hex trailDigest — the spec could not be bound to a trail.` | 14 | refusal |
| `graduate compose: --trail <path> carries a decision with no <field> — it cannot be digested.` | 14 | refusal |
| `graduate compose: --trail <path> holds zero decisions — there is nothing to synthesize.` | 16 | refusal |
| `graduate compose: --decisions names <ref>, which is not a decision on this trail — the refs on it are <list>.` | 4 | refusal |
| `graduate compose: --decisions selected zero decisions — there is nothing to synthesize.` | 16 | refusal |
| `graduate compose: stdin carries a "## Decisions" heading — that section is rendered from the trail, never authored.` | 17 | refusal |

**Scope** — the stdin bytes and the `--trail` file. Zero decisions in the trail is a **proven**
refusal (`16`), not an empty render: a spec whose decisions section is empty asserts that nothing
was decided, which is a claim rather than an absence.

**Examples**

```
$ fabrika graduate compose --trail trail.json <<'SPEC'
## Problem
Moderation weight is unbounded, so one vouched account can outvote a whole topic.

## Solution
Weight is earned per account and capped per topic; the vote table carries the cap.

## Out of scope
Weight decay on a clock — no decision yet, still open on #9412.
SPEC
## Problem
Moderation weight is unbounded, so one vouched account can outvote a whole topic.

## Solution
Weight is earned per account and capped per topic; the vote table carries the cap.

## Decisions
- Weight is earned per account, never inherited from a kefil. — **ruled** · R2.3
- The vote table has no per-account weight column today. — **established** · R2.1

## Out of scope
Weight decay on a clock — no decision yet, still open on #9412.
```

```
$ fabrika graduate compose --trail blocked.json < spec.md
graduate compose: --trail blocked.json reports readiness "blocked" — 1 decision(s) unresolved: R2.2. Refusing to synthesize a spec over a decision nobody made.
$ echo $?
13
```

**Grounding**

- #4110, #3148 — work proceeding past a decision nobody made. `13` is that failure refused rather
  than warned about, and it fires in the verb so it holds even when the skill's own step is skipped.
- #4227 — the provenance word and the source id are rendered from resolver output, so a downstream
  reader can tell a ruling from an agent's finding without the transcript.
- #3086 — a machine-local path reaching a posted body. The scan runs after splicing, so the rendered
  decisions are scanned too; `report file` composes before scanning for the same reason.
- The section floor is validated **before** the render, so a malformed authored body is `4` with
  nothing composed rather than a spec somebody has to delete.

---

## `graduate emit`

**Invocation**

```
fabrika graduate emit 9412 --spec spec.md --title "Cap moderation weight per topic" [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<source>` | positional integer | yes | — | the source issue the trail was read from; receives the emission marker |
| `--spec` | path | yes | — | a file holding the body `graduate compose` printed |
| `--title` | string | yes | — | the spec issue's title; type-neutral, and refused at `10` if it classifies |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository both issues live in |

**Behaviour, in this order.** Validates the spec body's four sections; **parses the refs out of the
body's rendered `## Decisions` section** — that list, not a flag, is what says which subset this
spec covers; re-derives the trail from `<source>` (the same dispatch `graduate trail` performs);
**checks each parsed ref against the re-derived trail and refuses at `18` if any ref is absent from
it or its provenance or text has changed** (refs on the trail but *absent from the spec* are the
remainder and are legal); computes the **spec digest** over the re-derived entries for exactly those
refs; reads the source's emission markers and refuses at `15` if one already binds that spec digest;
**appends the footer** carrying that digest; leak-scans the **composed whole, footer included**;
creates the issue; applies **exactly** `status:needs-triage`; reads the issue back; then posts the
marker carrying the digest and the covered refs.

The footer is appended **before** the leak scan, never after, for the reason `report file` does the
same: bytes added after a scan are bytes nobody scanned, and this footer interpolates a source
number and a digest. Ordering it after the scan would reopen #3086 on the one line this group adds
itself.

<!-- anchor: EIGHTEEN-IS-PER-REF-NOT-WHOLE-SECTION --> **`18` compares ref by ref, never the whole
section.** A whole-section equality check against the re-derived trail would fail every deliberately
split spec — the trail carries every decision and the spec carries a subset — which would reinstate
the stranded remainder through a different code. What `18` asserts is that each decision the spec
*does* carry still reads on the trail exactly as the spec states it.

**The digest is computed from the re-derived entries, not from the body's bytes.** The body supplies
only the ref *list*; the provenance and text that feed the digest come from the resolver. A forged
body therefore cannot forge a digest — it can at most name refs, and `18` checks those against the
trail first.

<!-- anchor: THE-BODY-MUST-MATCH-THE-TRAIL-IT-BINDS --> **Why emit re-checks rather than trusting
`--spec`.** Without it a caller can compose against trail A and emit against a source that has since
moved to trail B: the marker would bind a digest computed from B while the filed body stated A's
decisions, so the whole #4227 property — that the emitted `## Decisions` section IS what the
resolver returned — would hold only by luck. A `18` therefore means the source moved between compose
and emit, and re-composing is the fix.

<!-- anchor: WRITE-ORDERING-IS-AN-INVARIANT --> **Write ordering is an invariant, not an
implementation detail.** The spec issue is created **first** and the marker second, because an
interrupted run that wrote the marker first would leave a source claiming an emission that does not
exist — a trail that can never be graduated again and a spec nobody can find. The reverse leaves a
filed spec with no marker, which a re-run reports as `8` naming the orphan, and which a human
resolves by reading the source. A missing marker is a nuisance; a marker with no issue is a silently
dropped spec. The implementation owes a test for the order.

**The digest is re-derived here rather than passed in.** A `--digest` flag would let a caller bind a
marker to a trail the verb never read, which is the deferral-to-session-memory failure the
completeness test names: the only state threaded between verbs is the source number, an explicit
positional, and everything else is re-derived from the source itself.

**Output** — machine. One JSON object; every key always present:

```json
{"source":9412,"issue":9520,"url":"https://github.com/<owner>/<repo>/issues/9520","specDigest":"a1b2c3d4e5f6","labels":["status:needs-triage"],"marker":5234567892}
```

| Key | Type | Meaning |
|---|---|---|
| `source` | integer | the source issue number |
| `issue` | integer | the spec issue this call filed |
| `url` | string | the spec issue's HTML URL |
| `specDigest` | string | the 12-hex spec digest bound into the marker — equal to the trail digest exactly when the spec covers every decision on the trail |
| `labels` | array | always exactly `["status:needs-triage"]` — present so a reader never infers the absence of board state from an absent key |
| `marker` | integer | the id of the marker comment on the source |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `graduate emit: --spec <path> is missing section "<heading>".` | 4 | refusal |
| `graduate emit: --spec <path> has sections out of order — "<heading>" follows "<heading>".` | 4 | refusal |
| `graduate emit: --spec <path> has an empty section "<heading>".` | 4 | refusal |
| `graduate emit: the spec carries a machine-local path: <path> — refusing to file it.` | 5 | refusal |
| `graduate emit: the spec is a bare @ path reference — not redactable, refusing to file it.` | 6 | refusal |
| `graduate emit: #<n> does not exist.` | 7 | refusal |
| `graduate emit: label "status:needs-triage" does not exist in <repo> — refusing to file a spec no triage run can find. Create it, or run the front-door bootstrap (#4952).` | 7 | refusal |
| `graduate emit: the create failed, so whether a spec issue exists is UNKNOWN — check <repo> before re-running.` | 8 | refusal |
| `graduate emit: filed #<n> and the marker write failed — the spec EXISTS but #<source> does not record it, so a re-run would file a second. Post the marker or check #<source> before re-running.` | 8 | refusal |
| `graduate emit: filed #<n> but the read-back does not match what was sent.` | 9 | refusal |
| `graduate emit: --title classifies the work ("<term>") — type and priority are triage's (ADR 0246).` | 10 | refusal |
| `graduate emit: cannot read #<n>: <reason> — whether this trail was already graduated is UNKNOWN. Nothing was filed.` | 11 | refusal |
| `graduate emit: #<n> carries neither grilling:session nor wayfinding:map — there is no trail to bind this spec to.` | 12 | refusal |
| `graduate emit: #<n>'s trail reports readiness "blocked" — <n> decision(s) unresolved: <refs>. Nothing was filed.` | 13 | refusal |
| `graduate emit: #<n>'s trail carries a decision with no <field> — it cannot be digested, so the emission binding is UNKNOWN. Nothing was filed.` | 14 | refusal |
| `graduate emit: #<n> already graduated this decision set into #<m> at spec digest <hex> — refusing to file the same spec twice. A DIFFERENT subset of the trail may still be graduated.` | 15 | refusal |
| `graduate emit: #<n>'s trail holds zero decisions — there is nothing to file.` | 16 | refusal |
| `graduate emit: --spec <path> carries <ref>, which is no longer on #<n>'s trail — the source moved after the spec was composed. Re-run graduate trail and graduate compose.` | 18 | refusal |
| `graduate emit: --spec <path> carries <ref>, whose <provenance|text> on #<n> has changed since the spec was composed. Re-run graduate trail and graduate compose.` | 18 | refusal |
| `graduate emit: --spec <path> has a ## Decisions line that does not parse: <line>. That section is machine-rendered, so a line this shape means the body was hand-edited.` | 18 | refusal |

**Scope** — the source issue and every comment on it, paginated, to re-derive the trail and read
existing markers; plus one label existence read. An unpaginated comment read would miss an older
emission marker and file a duplicate spec, which is why pagination is load-bearing rather than
hygiene. A read that could not complete is `11` and files nothing.

**Examples**

```
$ fabrika graduate emit 9412 --spec spec.md --title "Cap moderation weight per topic"
{"source":9412,"issue":9520,"url":"https://github.com/<owner>/<repo>/issues/9520","specDigest":"a1b2c3d4e5f6","labels":["status:needs-triage"],"marker":5234567892}
```

```
$ fabrika graduate emit 9412 --spec spec.md --title "Cap moderation weight per topic"
graduate emit: #9412 already graduated this decision set into #9520 at spec digest a1b2c3d4e5f6 — refusing to file the same spec twice. A DIFFERENT subset of the trail may still be graduated.
$ echo $?
15
```

**Grounding**

- ADR 0246 — no board state and no close. `10` refuses a classifying title, the `labels` key is a
  fixed singleton, and there is no flag on this verb that could set a type, a priority, a milestone
  or an assignee. The source is never closed: that is `pipeline-cli tracker graduate`, which does
  the opposite of this verb.
- v1's `tracker` `createIssue` decodes the POST response but **never re-fetches**
  (`tracker/tracker.ts:628-642`), so a create that landed a truncated body reports success. Here the
  issue is read back and compared normalized before the marker is written.
- v1's `tracker` prints its result as prose on stdout (`tracker/command.ts:201`, `tracker: created
  #<n> — <url>`), so every caller regexes the number out of a sentence. Here the number is a field
  of the exit-`0` object.
- v1's `tracker` collapses every non-success onto exit `1` (`command.ts:42`,
  `BACKOFF_EXIT_CODE = 1`), fusing a proven "another agent holds it" with "the module failed to
  load" — the violation its own package documents at `exit-codes.ts:2-3`. Every proven refusal here
  sits at `3`+.
- v1's `graduate-map.sh` docblock claims it is fully-graduated-only while nothing in the script
  tests it, so it closes whatever number it is handed. This verb closes nothing at all.
- v1's `epic-splice` / `epic-lock` — the concurrent-writer pair, recorded here because an absent row
  reads as nobody checked. Both exist because `plan-epic` rewrites one live epic body in place, and
  both carry the same scar: the guard does not live where the write does. `epic-splice` ships only
  the pure text transform, leaving the optimistic `updated_at` recheck and the abort-retry PATCH in
  skill prose (`epic-splice/epic-splice.ts:10-12`), so a caller can splice without ever rechecking;
  `epic-lock` acquires by two non-atomic writes, so a failed claim POST leaves `status:planning`
  held on the epic for a human to clear (`epic-lock/command.ts:63-66`). **Neither scar has a surface
  in this group.** No verb here read-modify-writes an existing body — every write is a create (a new
  issue, its label set, and a new comment on the source), so there is nothing to clobber and no lock
  to take. The one repeat hazard that does remain, filing the same spec twice, is answered by the
  emission marker and the `15` digest refusal above rather than by a lock.
- #3086 — a machine-local path in a posted body. Both the body and the title are scanned.

---

## `graduate read`

**Invocation**

```
fabrika graduate read 9412 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<source>` | positional integer | yes | — | the source issue to read emission markers from |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository the source lives in |

**Output** — machine. One JSON object; every key always present:

```json
{"source":9412,"state":"graduated","emissions":[{"issue":9520,"specDigest":"a1b2c3d4e5f6","covers":["R1.2","R1.4","R1.1","R1.3"],"emittedAt":"2026-08-09T18:36:48Z","comment":5234567892}],"disregarded":[],"scanned":{"comments":14}}
```

| Key | Type | Meaning |
|---|---|---|
| `source` | integer | the source issue number |
| `state` | string | closed set — `graduated` when at least one marker parsed, `ungraduated` when none did |
| `emissions` | array | one object per parsed marker, oldest first, each with `issue`, `specDigest`, `covers` (the refs that emission specified) and `emittedAt`, plus its `comment` id |
| `disregarded` | array | every purported marker not counted: `comment`, `reason` (closed set — `malformed`), and `detail` |
| `scanned` | object | `comments` — the number read |

**`emissions` may hold more than one row**, and that is a fact rather than a defect. Two ways a
source legitimately graduates more than once: its trail grew after an emission, and — the ordinary
case — one run filed a coherent cluster while a later run graduated the remainder. `graduate emit`
refuses only a repeat of the **same spec** digest, so the array records the sequence.

**Coverage is derivable, and only because the marker carries its refs.** Union the `covers` arrays
and you have the refs already specified; the refs on a trail that are *not* in that union are the
remainder. This verb does **not** compute that union and never reads the trail — it reports what the
markers say, and the caller holding a `graduate trail` result does the comparison. Keeping the
arithmetic out of here preserves this verb's split test: it stays a total marker read that makes no
judgment.

<!-- anchor: READ-NEVER-REFUSES-ON-CONTENT --> **This verb never refuses on marker content.** A
malformed marker is **data** — reported in `disregarded` at exit `0`, never a refusal. Refusing
would suppress the whole emission history over one bad comment and would let anyone with write
access disable the verb by posting one. Its only refusals are a source that does not exist (`7`), a
source carrying neither label (`12`), and a read that could not complete (`11`).

<!-- anchor: MALFORMED-IS-NOT-UNGRADUATED --> **A source whose only marker is malformed reads
`ungraduated` with a non-empty `disregarded`**, and a caller must read both. This is the one place
this group's design is knowingly conservative in the *unsafe* direction, so it is stated rather than
hidden: `graduate emit` re-reads markers itself and treats a malformed one as unparseable, so a
mangled marker can let a second spec be filed for one trail. The alternative — refusing every
emission whenever any comment is malformed — would let one bad comment permanently block a source.
The `disregarded` row is what makes the state visible; closing it mechanically needs a marker that
cannot be half-written, which is out of scope here.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `graduate read: #<n> does not exist.` | 7 | refusal |
| `graduate read: cannot read the comments on #<n>: <reason> — whether this source graduated is UNKNOWN, never "no".` | 11 | refusal |
| `graduate read: #<n> carries neither grilling:session nor wayfinding:map.` | 12 | refusal |

**Scope** — every comment on the source, paginated. **Zero comments is a fact** (`ungraduated`); a
read that could not complete is `11`, never an empty history.

**Examples**

```
$ fabrika graduate read 9412
{"source":9412,"state":"ungraduated","emissions":[],"disregarded":[],"scanned":{"comments":3}}
$ echo $?
0
```

```
$ fabrika graduate read 9999
graduate read: #9999 does not exist.
$ echo $?
7
```

**Grounding**

- `pipeline-cli intake-dedup` prints nothing and exits `0` both when it found no candidates and when
  it had no usable keywords (`intake-dedup/command.ts:55-56`), so "never checked" is byte-identical
  to "checked, found nothing". Here `state` is always a printed word and `scanned.comments` says what
  it rests on.
- #4163 — a stale read failing toward "does not exist", a wrong answer indistinguishable from a
  right one. A comment read that cannot complete is `11`, never `ungraduated`.
- The malformed-versus-absent split is the `wire/verdict-marker.ts` three-valued read; a real
  emission written in the wrong shape is visible in `disregarded` rather than silently absent.

---

## Required repo files (verb-level)

fabrika installs into repos that are not the one it was authored in. The **when-missing** vocabulary
is closed and is the same in every fabrika skill, so one reader parses all of them: **fail-loud**
(stop, name the surface, point at front-door), **degrade** (continue with a narrower answer,
stated), **bootstrap** (front-door creates it —
[#4952](https://github.com/kamp-us/phoenix/issues/4952)).

| Must exist | Why | When missing |
| --- | --- | --- |
| `gh` authenticated to `--repo` with `issues: write` | every verb reads an issue; `graduate emit` creates one and comments on another | **fail-loud** — `11` before any write, `8` after one; never a silent empty answer |
| The `status:needs-triage` label | the only label `graduate emit` applies, and what makes the spec findable by triage | **fail-loud** — `7` naming the label; front-door bootstrap #4952 |
| A source issue carrying `grilling:session` or `wayfinding:map` | the only two trail surfaces | **fail-loud** — `12`. A repo with neither has nothing to graduate, which is a first-run **fact**: the way forward is a `grilling` session, not a fix to this group |
| `repos/<owner>/<repo>/collaborators/<login>/permission` readable | the imported `grill read` resolver checks a ruling's authority against it (ADR 0055) | **fail-loud** — `11`, and the trail is UNKNOWN: never `ready`. The load-bearing row — a degrade here would license synthesizing over an unproven ruling |

Nothing else. No `.decisions/`, no `.patterns/`, no CODEOWNERS, no merge-queue configuration, no
design manifest: this group opens no pull request and gates no merge. Stated explicitly, because an
absent row reads as nobody checked.

<!-- anchor: FIRST-RUN-HAS-A-WAY-FORWARD --> **No refusal here is a first-run dead-end.** A fresh
repo hits exactly two of the rows above: the missing label (`7`, bootstrapped by front-door) and the
absent source (`12`, whose way forward is to run `grilling` first). Neither is a state a new adopter
can reach and be stuck in, which is the failure a sibling shipped when its first ADR was
structurally unmintable.

## Completeness self-test

The six presence tests in the [interface convention Part 2](../../docs/cli-interface-convention.md)
hold: every flag has a type and a default, every stdout shape is shown by an example, every non-zero
code is enumerated with its trigger, every error names its message, stream and code, every judging
verb states its scope and zero-scope behaviour, and no clause defers to a v1 script, another skill's
prose, or the authoring session.

The five hand-checks those tests cannot perform:

1. **Every reachable outcome has a code.** Walked per verb. Two that nearly escaped: `graduate emit`
   creating the issue and then failing the marker write — a spec that exists while its source does
   not record it, so a re-run would file a second — seated on `8` with a message naming the orphan
   and a specified write order that makes the surviving half the recoverable one; and a source
   carrying *both* source labels, which is `12` rather than a silent pick.
2. **Every value an example prints is derivable from the spec.** The digest is defined as an
   algorithm over named fields, not shown as a magic literal; `kind`, `readiness`, `provenance`,
   `state` and `disregarded[].reason` are all closed sets enumerated above; `labels` is a fixed
   singleton. No example prints a score, a ranking or an id the spec does not derive.
3. **Every literal obeys the spec's own stated formats.** Every digest literal is exactly 12
   lowercase hex; every timestamp is ISO-8601 UTC with a `Z`; every JSON example parses; every issue
   number used as an example sits well above the host repository's live range, and no example names
   a real repository — `<owner>/<repo>` stands in, so a foreign adopter pasting one cannot target
   someone else's board.
4. **Every value a later verb needs arrives as an argument.** No clause refers to "the digest at
   trail time" or "the decisions you read": `graduate emit` re-derives the trail and the digest from
   the source itself, and the only state threaded between verbs is the source number and the
   `--trail` / `--spec` files, all explicit. There is deliberately no `--digest` flag.
5. **Every conditional output key states when it is present.** Every key on every verb's object is
   always present; `emissions` and `disregarded` are empty arrays rather than absent keys, so a
   consumer never infers optionality from an example.

**No local scratch state, so the shared-state law has no surface here.** Every artifact this group
touches lives on GitHub keyed by issue and comment id; no verb writes a temp directory, so the
session-keyed collision recorded at [#4516](https://github.com/kamp-us/phoenix/issues/4516) cannot
occur. Stated because an absent answer to that question reads as one nobody asked.
