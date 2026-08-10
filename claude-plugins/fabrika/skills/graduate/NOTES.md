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

Recorded after the runs; see the authoring handoff on
[#5103](https://github.com/kamp-us/phoenix/issues/5103) for the measured numbers, the discriminating
count, and the terminals no fixture exercises.
