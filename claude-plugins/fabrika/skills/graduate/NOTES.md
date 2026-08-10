# `graduate` — packaging, pricing, and what stayed open

Reference for a reader deciding about this skill, not run-time instruction. `SKILL.md` points here
so the page the model reads every invocation carries none of it.

## Invocation axis, priced

`graduate` is **model-invocable** — it carries a `description` and no `disable-model-invocation`.
Convention §3 says to choose that only when the model must reach the skill unprompted, so here is
the argument rather than the assumption.

**Why model-invocable is right.** The ruled shortest path is a chain — `grilling` → `graduate` →
one issue — and a chain is advanced by *the model firing the next Skill tool*. A user-only skill
**cannot be a link in a stack** and cannot be preloaded into a dispatched subagent, so a user-only
`graduate` would sever the quintet exactly where it is supposed to hand off, leaving the emission
step reachable only by a human who remembers to type it. That is the failure the skill exists to
prevent, one level up: the spec that never gets written because nobody was at the keyboard.

**What that costs, stated.** The description is ~730 characters of always-in-context load, on every
turn, forever — the price of discovery, paid whether or not the skill fires.

**What is not claimed.** Nothing here argues the description is well-tuned. The trigger-optimizer
measurement is reported in the authoring handoff.

## The name, and why this contract does not re-open it

`graduate` collides with three other live surfaces (`pipeline-cli tracker graduate`, `anka-ops flag
graduate`, and fog-graduation inside a map). The founder ruled **keep** on
[#5017](https://github.com/kamp-us/phoenix/issues/5017) comment 5230781267, and ADR
[0246](../../../../.decisions/0246-graduate-keeps-its-name-disambiguated.md) is the disambiguation.
An authoring session may not re-open rename-versus-keep, and this one did not.

The collision worth holding in mind while reading the contract is that `pipeline-cli tracker
graduate` **closes** an issue and this skill **opens** one — near-opposites sharing a spelling. That
is why the contract states "closes nothing" more than once: the name pulls a careless reader toward
the wrong direction, and the ADR's own rule is that the namespace decides, never the vibe.

## What the brief got right, and the one thing it could not know

The brief (#5103) is accurate on every ruling it carries. One field aged between minting and firing,
and it is the most important one:

**Field 4 points at v1 prior art — `pipeline-cli wayfinder-map`, `intake-dedup`, `tracker`,
`epic-splice`, `epic-lock` — and names no fabrika sibling.** By the time this session ran, both
`grilling` (#5019) and `wayfinding` (#5018) had landed on `main`, and their contracts *are* this
skill's real input interface: `grill read` and `map read` each emit a resolved, ACL-checked state
per question or ticket, and both say in as many words that `clear` is the token `graduate` keys on.
The v1 tools remain the right scars to design against; they are simply not where the input shape
comes from any more. This is the ordinary decay every brief carries, not a defect in the brief.

**A second aged claim, in the brief's acceptance criteria rather than its fields:** the criterion
requiring the `SKILL.md` to sit "inside the 7–140 line band". `skill-conventions.md` §2 now reads
*"There is no line count"* (founder-delegated ruling on #4701, jointly #5219), and the
authoring-brief contract's own field 6 says a brief may carry **no** sizing acceptance criterion,
because a number there is a second source of truth for a rule that deliberately has none. Authored
against the live rule — the structural split — and reported in the handoff rather than silently
obeyed or silently ignored.

## Why the two sibling resolvers are imported rather than re-parsed

The single largest design decision here, and the one most worth re-checking if this skill ever
misbehaves. `graduate trail` calls `grill read`'s and `map read`'s resolvers instead of parsing the
session or the map itself.

The alternative — accepting the sibling's JSON on stdin — was considered and rejected. It is
forgeable: an agent could hand `graduate` a trail asserting a ruling that was never made, and every
downstream guard would pass because the artifact would be internally consistent. Importing the
resolver means the ACL check, the four ruling clauses and the digest comparison all run inside this
group's own call, so "is this ruled" has exactly one answer in the codebase.

**The cost is a hard sequencing dependency**: neither module exists yet (#5022, #5023 are held), so
this group cannot be implemented until both land. That is stated in the contract and carried in the
implementation ticket rather than left for a coder to discover.

## Why the spec carries no pre-drafted pitch

The quintet ruling ([#5017](https://github.com/kamp-us/phoenix/issues/5017) comment 5229701965)
says a lane-entering spec's pitch stamp stays a founder seat and that this skill **may** pre-draft
the five fields. May, not must — and this contract does not.

The reason is that there is nowhere to put them that does not break something else. The spec body
is four sections and `graduate compose` refuses any authored section outside the three it takes
(`4`), so a pre-drafted pitch would need either a fifth section, a `--pitch` flag, or a second
artifact. All three widen the emitted issue past *one spec issue at `status:needs-triage`*, and the
first two put agent-authored fields next to the machine-rendered `## Decisions` section, which is
the one part of the body a downstream reader is supposed to be able to trust without the transcript.

A first draft of the `SKILL.md` told the model to pre-draft the pitch anyway. That was an
instruction with no verb behind it — the skill ordering an artifact the contract cannot carry — and
the skill-reviewer pass caught it. Recorded here rather than silently dropped, because the ruling
does permit the pre-draft and a later session may want to add it deliberately: doing so means
deciding where the fields live and how they stay visibly agent-authored, not just adding a flag.

## The defect a graded run found that three reviewers did not

Worth recording in full, because it is the sharpest instance here of the rule that a reviewer
confirms a thing is written down while a run has to actually do it.

`SKILL.md` §2 tells a caller whose trail spans two buildable things to file the coherent whole and
name the remainder in `## Out of scope`. The first revision had `graduate emit` bind its marker to
the **trail** digest — every decision on the trail. The eval-3 with-skill run followed both rules
and noticed they contradict: since the digest covers the decisions it *didn't* file, the `15`
refusal would reject a second run over the remainder forever. **The mechanism guaranteeing
one-issue-per-invocation was the same mechanism stranding every leftover**, so a deliberately split
trail could never be finished.

Three review passes — a narrative reviewer, a mechanical matrix audit, and a premise-verification
pass — all cleared it. None had to *use* the rule.

The fix is that the marker binds the **spec** digest, taken over the decisions actually rendered
into the filed spec, with `graduate compose --decisions` naming the subset. A remainder then
graduates as its own spec; a true duplicate of the same decision set is still refused. The algorithm
is unchanged, so when a spec carries the whole trail the two digests coincide by construction.

**Disclosure: this fix landed after the graded runs.** The runs measured the skill as it read
before it, so their pass rate does not cover the `--decisions` path or the second-run remainder
case. A next iteration should exercise both directly. This is the same shape as `grilling`'s own
liveness bug (a re-worded question holding the frontier forever, making `clear` unreachable and
`graduate` unrunnable) — also found by a run rather than a reviewer.

## What is deliberately conservative in the unsafe direction

One, and it is named in the contract at `MALFORMED-IS-NOT-UNGRADUATED`. A source whose only emission
marker is malformed reads `ungraduated`, so `graduate emit` can file a second spec for one trail.
The alternative — refusing every emission whenever any comment on the source is malformed — lets one
bad comment permanently block a source, which is worse. The malformed marker is surfaced in
`disregarded` so the state is visible. Closing it mechanically needs a marker that cannot be
half-written, which is out of scope for this contract.

## Open questions this session did not answer

- **The content-ingestion trust posture** is unruled at
  [#4859](https://github.com/kamp-us/phoenix/issues/4859). This skill's §ING declares the seam —
  what it reads, and that authority arrives only through the resolver's ACL check — and writes down
  no posture, per the brief's own instruction and convention §9.
- **Whether the eval corpus gains an ideation stage.** `STAGES` in
  `packages/fabrika-cli/src/eval/corpus.ts` holds `triage`, `build`, `review`, `ship-it` and no
  ideation entry, and stage admission is demand-driven — a skill must be on disk *and* carry
  committed ground truth. [#5241](https://github.com/kamp-us/phoenix/issues/5241) holds three
  unruled branches. This session declares no stage entry and takes no position.
- **Whether `report`'s `checkSections` should be parameterized** so a non-intake caller can reuse it
  rather than owning a second section list. This contract owns its own list and widens nothing;
  the alternative is a real refactor with its own risk, and it is somebody's decision rather than
  this session's.

## Eval coverage, and what it does not reach

Five evals, 31 assertions, two arms. **with-skill 30/30; baseline 22/30.** Discriminating: **8 raw,
4 distinct** — the terminal-token assertion is one property restated once per eval, so counting rows
would overstate behavioural lift by 5×. One of the four is vocabulary (the baseline judged every
situation correctly and minted `BLOCKED`, `SPECIFIED`, `Already graduated` instead of the closed
tokens); three are substance: the spec body's four-section shape, **who writes `## Decisions`** (the
baseline hand-authored the whole body including that section — the skill's central integrity claim,
and the one a baseline simply does not have), and remainder handling on a two-subject trail.

Cost: **+47% tokens, +36% wall-clock** against baseline. That is the skill's price and it belongs
beside the pass rate.

**A 30/30 is not a clean bill of health.** It means the keys are calibrated to this skill's own
vocabulary and are not probing past it. The two findings below both came from outside the
scorecard.

**What no fixture exercises:** `TRAIL-EMPTY`, `SPEC-COMPOSED`, `SOURCE-UNRESOLVED`, `INPUT-REFUSED`,
`WRITE-UNPROVEN`, `STOPPED` and `NOTE-ADDED` (7 of 11 terminals); the `empty` readiness token; a
`disregardedEntries` row; a malformed emission marker; and — because both landed after the runs —
the `--decisions` subset path and the second-run remainder.

**Annotated leaks, kept as regression cover and not counted as discriminators:** 1.4, 3.5 and 5.6
(each fixture's trail JSON prints the provenance word per ref, so provenance faithfulness is
transcription), 4.3 (#9491 is printed verbatim), and 2.3 (both unresolved refs are spelled out in
prose). Disputed and kept as real: 2.6 — the fixture prints the bare token `stale`, and the reading
that it means *previously answered, now un-ruled, and more dangerous than `open` because a skim
reads it as settled* is nowhere in the fixture.

**A key defect the grader caught:** assertion 5.6 named `#9505` as the ruled entry, a ref that no
longer exists — the pre-run fixture repair renumbered it to `#9301 R1.2`, because a map *ticket*
cannot resolve to `ruled` and only a `## Decisions` entry citing a session ruling can. Both arms
were graded generously against the intent and passed; the clause is repaired in `evals.json` and
the graded runs scored the old wording.

## The second thing the scorecard was blind to

Asked to read all ten runs side by side, the grader found the skill answering one question **two
different ways**. The fixtures for evals 1, 3 and 5 never run `graduate read`. In all three the
with-skill arm recorded the command, assumed `ungraduated`, and filed on that assumption. In eval-2,
facing the identical gap, it refused to assume.

So the rule read as *assume the precondition when assuming lets you write; refuse when it does not
matter* — which is exactly backwards, and eval-4 is the case that proves it: a trail can read `ready`
and already be graduated, and nothing but the read distinguishes them. Fixed by the
`NEVER-WRITE-ON-AN-ASSUMED-READ` anchor in `SKILL.md` §1, which names the temptation directly. The
fix landed after the runs, so no graded assertion covers it.
