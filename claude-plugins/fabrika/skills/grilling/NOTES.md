# `grilling` — packaging, pricing, and what stayed open

Reference for a reader deciding about this skill, not run-time instruction. `SKILL.md` points here
so the page the model reads every invocation carries none of it.

## Invocation axis, priced

`grilling` is **model-invocable** — it carries a `description` and no `disable-model-invocation`.
Convention §3 says to choose that only when the model must reach the skill unprompted, so here is
the argument rather than the assumption.

**Why model-invocable is the right setting.** Two of the three ways this skill gets used are
model-initiated. `wayfinding` composes it — a wayfinding ticket session reaches grilling because
the model fires it, and a user-only skill **cannot be one link in a stack**, which would break the
composition the quintet ruling requires. It also cannot be preloaded into a dispatched subagent, and
the ruled shortest path (`grilling` → `graduate` → one issue) is a chain the model advances. A
user-only grilling would leave the quintet with a primitive only a human at a keyboard can start,
which is precisely the shape #4903 records as the cost of a router-fronted corpus.

**What that costs, stated.** The description is ~930 characters of always-in-context load, on every
turn, forever — the price of discovery, paid whether or not the skill fires. That is the largest
single lever available here and it is deliberately spent: an un-fired grilling session means a
decision gets made by whoever is closest to the keyboard, which is the failure the whole skill
exists to prevent.

**What is not claimed.** Nothing here argues the description is well-tuned. The trigger-optimizer
measurement is reported in the authoring handoff; across nine prior fabrika skills it has moved
nothing, and the original description was kept.

## Eval coverage, and what it does not reach

Five evals, 38 assertions. They exercise `grill open`, `grill round`, `grill answer` and `grill
read`, and reach four of the twelve terminals — `ROUND-POSTED`, `AWAITING-FOUNDER`,
`RECORD-REFUSED`, `SESSION-OPENED`.

**Unexercised, stated so nobody reads the set as complete:** a successful `grill rule` (every eval
that touches ruling is a refusal path), `FACT-ANSWERED`, `FACTS-PENDING`, `FRONTIER-CLEAR`,
`INPUT-REFUSED`, `SESSION-UNRESOLVED`, `WRITE-UNPROVEN`, `STOPPED`, and the frontier tokens
`facts-pending`, `clear` and `empty`.

**Three surfaces no eval touches at all, and one of them is why a bug survived three reviews.**
`unattested`, `superseded` / `grill round --supersedes`, and a non-empty `disregarded[]` appear in no
fixture and no assertion. The `superseded` gap is the instructive one: the liveness bug it fixes —
a re-worded question holding the frontier forever, so `clear` was unreachable and `graduate` could
never run — was found by a graded run reasoning past the fixtures, not by the eval set. A next
iteration should cover all three directly.

**Known leaks, annotated in `evals.json` rather than quietly repaired:** assertions 3.1 and 3.5 are
echo-passable, because eval-3's transcript prints the state words they assert; 2.4 and 4.3 are
passable by ignorance, since a baseline that has never heard of `grill-ruled:` cannot emit one. All
four are kept as regression cover and none is counted as a discriminator.

## The design fork that was decided, and why it is recorded

An earlier draft split ruled questions into `ruled-direct` (a bare marker, "authored directly") and
`ruled-relayed` (a marker with an adjacent authorization), and treated the bare one as stronger
evidence. Review killed it, correctly, for two independent reasons: *authored directly* is not a
checkable property, since every crew agent writes to GitHub as the founder's account and the
2026-08-09 ruling on [#4619](https://github.com/kamp-us/phoenix/issues/4619#issuecomment-5230098869)
settles that filings from that account read as agent-authored regardless of footer; and #4938
declares a bare stamp void. The shipped design has one ruled state and surfaces a bare marker as
`unattested`.

It is written down here, and in `contract.md`'s `NO-DIRECT-VS-RELAYED-SPLIT` anchor, because it is a
proposal someone will plausibly make again — the intuition that "he posted it himself, so it counts
more" is a natural one and is wrong for a reason that is not obvious. Convention §7 would put this
in `.out-of-scope/`; that directory does not exist yet at the plugin root, so it lives here until it
does.

## Open questions this session carried, and did not answer

- **What `graduate` needs from a session, exactly.** #5103 requires the founder's recorded decisions
  to be separable from the skill's synthesis. Three distinct marker formats plus `recordedAs` and
  `proof` are this skill's offer, derived without reading `graduate`'s unbuilt internals. If that
  brief needs a different shape, this contract is what it should argue against.
- **Whether `wayfinding` needs a verb to summarize a session back to a map.** #5018 scopes the
  founder-decision fork *out* of itself and into this brief, but the reverse direction — a map
  summarizing a grilling session's resolutions — is `wayfinding`'s to specify. Nothing here presumes
  it, and no verb was invented on its behalf.
- **Whether `unattested` should be reported to the founder proactively.** The skill tells the model
  to surface disregarded markers; it does not say a stamp-without-authorization deserves its own
  escalation. Left to practice rather than guessed at.
- **The mechanical version of ruling provenance is blocked on
  [#4441](https://github.com/kamp-us/phoenix/issues/4441)** — a recorded ruling is indistinguishable
  from a fabricated one at the point it is recorded. This skill makes the authorization required,
  quoted and bound, which is strictly better than prose self-attestation and still not proof.
- **The content-ingestion trust posture is open at
  [#4859](https://github.com/kamp-us/phoenix/issues/4859).** `SKILL.md` states the seam and writes
  no posture down. Note the second §ING tier — repository source and subagent reports — is not
  verb-mediated, so when #4859 is ruled it lands as one verb change for the first tier and a
  separate change here.

## Routing — does a path reach this skill in deployment?

**No.** No routing path reaches any fabrika skill today: `CLAUDE.md` pins skill routing to a
filesystem path under `.claude/skills/`, which resolves to the v1 copy
([#4761](https://github.com/kamp-us/phoenix/issues/4761)), and the `.claude/skills` symlink loads v1
regardless of the plugin toggle ([#4829](https://github.com/kamp-us/phoenix/issues/4829)). Both are
open and already filed; this skill adds a case to them rather than a new problem, so nothing further
was filed. A model-invocable description is what reaches this skill in the meantime.

## Measured, iteration 1

Measured against the **pre-`supersede` revision** — the runs predate `grill round --supersedes`,
the `superseded` state and the ACL clause on answer markers, all of which landed after grading.
Five evals, 38 assertions, both arms. **with-skill 38/38; baseline 23/38.** Discriminating: **15 raw
rows, 11 distinct** — **12 rows / 10 distinct SUBSTANCE**, 3 rows / 1 distinct VOCABULARY. Cost:
**with-skill 90.8k tokens / 149s against baseline 58.8k / 127s — +55% tokens, +17% wall-clock**,
inside the +45–70% band the prior fabrika skills established.

**A 100% arm is a smell, not a triumph**, and it is recorded as one: a key the skill clears perfectly
is either well-matched or written off the skill's own vocabulary, and at least two assertions (`1.1`,
`1.7`) are close to tautological for a skill that ships the closed sets they test. Eval 3 scored 7/7
in **both** arms — a no-op, exactly as its own leak annotation predicted, because its transcript
prints the state words the key asks for.

**What the baseline did that the scorecard barely captures:** it invented six verbs that do not exist
(`grill show`, `grill ask`, `grill add`, `grill note`, `grill round add --body-file`,
`grill close --emit-issue`), built its plans on them while admitting it was guessing, composed and
staged the spec issue itself in eval 5 rather than stopping, and in eval 2 proposed a remedy —
"the founder confirms in the session under his own identity" — that would accept founder *prose* as a
ruling. It reached correct verdicts by inventing an authority model that happens to be wrong.
