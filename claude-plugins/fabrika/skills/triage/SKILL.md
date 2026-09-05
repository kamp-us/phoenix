---
name: triage
description: "Turn one raw `status:needs-triage` issue into a single actionable unit a builder can pick up cold. Trigger on \"/triage\", \"triage the queue\", \"triage issue #N\", \"process needs-triage\", \"classify these issues\", and whenever someone asks to make the backlog actionable or pickable."
arguments: [issue_number]
argument-hint: "[issue-number] — the raw issue to triage"
---

# triage

You are the guardrail. **The failure that matters is not a missing label — it is a confident wrong
one**, indistinguishable from a correct one once it lands. Each step makes its answer checkable, not
merely well-formed. You have full rewrite authority; **salvage first**.

## 1 — Claim it before you mutate it

The issue you were invoked on is `$issue_number`, and every command below carries it. A blank there
does not mean no number exists: a preloaded agent shell (`skills:` frontmatter) always substitutes
blank, because the harness hands the preload an empty argument and the number arrives in the spawn
brief instead — so on a blank, take the issue your caller named there. Only when no caller named
one are you actually without a number, and then ask for it before running a verb. Never invent one
nobody named.

```bash
fabrika triage claim $issue_number
```

Done when it printed `won\t<claim-token>` — that means **this lane** holds it; on anything else, move
on. **Keep the token.** A fan-out runs several triagers under one session id, so the token is the
only thing that tells your lane from a sibling's: pass it back as `--token` if you ever re-run the
claim, and never re-run without it — a tokenless re-run is a new lane racing your own. What `lost`
proves, and which refusal each exit code carries, is the verb's own section
(`fabrika wire doc-section --heading "triage claim" < <skill-base>/contract.md`).

**That rule has teeth now, and the token is what gives it them.** Every verb below that writes —
`enrich`, `apply`, `park`, `kill`, `split` — re-reads the claim before its first write and refuses
on `17` when a live marker names another claimant, so proceeding on a `lost` no longer overwrites the
winner's work; it just fails. **Pass `--token <claim-token>` to every one of those five.** Without it
the verb can only tell that *some* lane of your session holds the claim, which is exactly the sibling
it cannot tell you from — so it falls back to a fail-closed reading and refuses the moment two lanes
of your session hold live markers. With it, a sibling's claim is refused and your own passes. The
same re-read refuses a closed target on `7`. Neither refusal is overridable, and a comment read that
fails is `11` — never a pass.

**Every working file you write goes where this prints, and nowhere else:**

```bash
fabrika triage scratch $issue_number --slug authored --token <claim-token>
```

The token's nonce is what keys that directory to your lane. A fan-out shares one session
scratchpad, so a file named by convention — `authored.md` — is overwritten by a sibling lane
silently, and the body you then post is another issue's
([#6630](https://github.com/kamp-us/phoenix/issues/6630)). The path it prints is machine-local and
must never reach a posted artifact; the writing verbs red on it (`5`).

## 2 — Read the issue, then read the code it is about

Never classify from the title. Read the body, then read enough of the repo to say what this is about
in your own words. **Check any falsifiable claim it rests on against source before enriching on top
of it** — a summary of a contract is not the contract. A hand-filed issue skipped dedup:

```bash
fabrika report dedup --query "sozluk definition editor loses focus after save" --exclude $issue_number
```

Read `candidates` yourself — shared vocabulary is not a shared observation; `indeterminate` is a
non-check, so re-query. `--exclude` is this group's extension to the `report` verb, and its grammar
is the section that adds it:
`fabrika wire doc-section --heading "report dedup — the --exclude extension" < <skill-base>/contract.md`. A duplicate routes by who filed it (step 8).

**On an agent-filed report, read the gap at `origin/main` before you enrich anything on top of it.**
An agent files from a worktree whose skills and code were cut before a fix merged, so it reports a
gap main has already closed — and enriching that is a founder ruling spent on a bug that was never
live. Four parked KILLs in one drain were this one shape
([#6527](https://github.com/kamp-us/phoenix/issues/6527),
[#6519](https://github.com/kamp-us/phoenix/issues/6519),
[#6526](https://github.com/kamp-us/phoenix/issues/6526),
[#6512](https://github.com/kamp-us/phoenix/issues/6512)). So fetch, then read the file or verb the
issue names **at main** — never the copy in the checkout you are standing in, which is the filer's
snapshot or your own:

```bash
git fetch origin main
git show origin/main:packages/fabrika-cli/src/lane/assembly-verb.ts
```

A gap the artifact at main no longer has is **superseded**: close it yourself under §8's `superseded`
clause with `fabrika triage kill $issue_number --confirm`, and say in the note what landed and where
you read it. **No founder ruling is owed for that close** — the
[#6070 (c) ruling](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454) already
lets triage close a twin on its own judgment, and ADR
[0328](../../../../.decisions/0328-report-freshness-check-at-triage.md) puts this check at this
layer for the same reason. This close carries no `--duplicate-of`, so it reaches agent filings only:
§8's rule stands unchanged — **a human filing is parked, never killed** on this path, however
plainly main already fixed it. Fold it into a survivor with `--duplicate-of` and provenance stops
mattering; a bare `--confirm` close of a human filing still refuses on `12`.

Done when you can state the issue from the code, the dedup outcome is read, and an agent-filed gap
has been read at main.

## 3 — Classify into exactly one of six types

| Type | The issue is this when… |
|---|---|
| `type:bug` | **Behavior diverges from intent.** Something built does the wrong thing; a "supposed to" is violated. |
| `type:feature` | **A new capability, directly implementable.** It does not exist, the path is clear, it fits in a PR or a few. |
| `type:chore` | **No behavior change.** Refactor, rename, dep bump, doc edit — observable behavior is identical after. |
| `type:decision` | **One question; the output is a recorded choice.** The deliverable is "we decided X", not "we built X". |
| `type:investigation` | **An unknown; the output is knowledge.** You cannot say what to build because nobody knows what is wrong. |
| `type:epic` | **Too big for one PR; it spawns children.** The deliverable is a plan plus sub-issues. |

- **decision vs epic** — one question → decision; many, or questions-plus-buildable-children → epic.
- **bug vs investigation** — a nameable fix → bug. An investigation whose answer *might* be trivial
  stays one; `build` owns that collapse, and re-typing in anticipation was rejected.
- **feature vs epic** — judge the *real* deliverable. **Do not invent a v1 scope to make an epic fit
  a PR**; if you must carve the work down to call it a feature, it is an epic and your carve-out is
  its first child. Tells: missing prerequisite infrastructure, implied new surfaces, and your own
  hedging — "if this balloons, split X out" is the epic boundary talking.
- **decision vs the type you already picked** — if landing on that type meant rejecting a *named
  alternative* on a developer-experience or product-facing surface, the rejection is the tell:
  someone still has to pick that direction, so it leaves triage as a `type:decision`, or as the type
  you picked stamped `ready-for:human` in step 7. **"Forced" describes implementation mechanics,
  never direction** — step 4's *forced fit* is the separate question of where a ticket attaches — and
  "no PR in this repo can change X" eliminates nothing on its own, because the code X invokes is
  usually repo-ownable (#5679's global shim vs `packages/fabrika-cli/src/bin.ts`; that exclusion cost
  a full build round).

Done when one type holds and you can name the question that excluded its nearest neighbour — a
question about which category this is, never about which direction it should take.

## 4 — Attach before you mint

**Search the board for an open epic or issue on the same surface before you leave this as standalone
work.** Step 2's dedup asks whether this exact observation is already filed; this asks the wider
question — is there already a ticket that *owns this surface* and should absorb it? Query on the
surface, not on your issue's wording:

```bash
fabrika report dedup --query "sozluk definition editor keyboard focus" --exclude $issue_number
```

Read the candidates yourself and take the cheapest true route:

- **An open epic or issue already owns this surface** → **fold in and close**, which is the preferred
  outcome. Add this issue's content to the survivor, then close this one against it so the trail runs
  both ways — the survivor carries the content, this issue points at the survivor. `fabrika triage
  kill $issue_number --confirm --duplicate-of 4290` is the folding route, and it is open whatever the
  provenance — a human filing folds and closes here exactly as an agent filing does
  ([#6070's ruling](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454)), because
  a fold moves the content into the survivor instead of discarding it. `--confirm` is still required,
  and it is the `--duplicate-of` that opens the close, not the `--confirm`: a bare `--confirm` close
  of a human filing still refuses on `12` (step 8).
- **Several small items cluster on one surface with no owner yet** → **make the cluster an epic**
  rather than minting each item as its own ticket. An epic's children ship as one pull request, so a
  cluster of small items costs one review-and-merge round instead of five.
- **Nothing owns the surface, or the fit is forced** → **mint it standalone and say why** in your
  step 6 rewrite: one line naming what you searched and why nothing absorbed it. A forced fold-in is
  worse than a new ticket; the reason is what stops the next triager re-litigating the same search.

Done when you have taken one of the three routes and the reason is written down.

## 5 — Split a bundle into single units

Two problems agents could work at different times are a bundle; two facets of one change are not.

```bash
fabrika triage split $issue_number --title "Editor loses focus after save" --token <claim-token> <<'EOF'
…
EOF
```

What the child carries over from the parent, and what it deliberately does not, is the verb's
section (`fabrika wire doc-section --heading "triage split" < <skill-base>/contract.md`, and
`--heading "The child this verb creates"` for the child's shape).

Done when every unit is separately pickable. **A human-filed original always stays one of the
units** — only an agent filing may be left as an empty husk and killed, because a husk parked on
`status:needs-info` is a question nobody can answer. The `--duplicate-of` exception below does not
reach here: a split leaves no survivor to fold the original into, so nothing licenses that close.

## 6 — Home it, then enrich: rewrite on top, original preserved beneath

**Every issue leaves with a home** — an open milestone, or one of the two standing lanes.
Lane-entering work (an epic, or a parentless feature) additionally carries a `## Pitch` whose `Arc`
*is* that home — inside your rewrite for a feature, on stdin for an epic — and **only the founder
approves a pitch**. Take an existing home: **triage never creates a milestone**, and
`wayfinder:backlog` is bounded to genuine fog rather than work you would rather not decide about.
**An `active` campaign's milestone is closed to new intake** unless the work is `p0` or `p1`, or
blocks one of that milestone's own in-flight lanes (ADR 0354) — `triage homes` marks those rows
`running: p0/p1 or blocker`, and is where you read which milestones they are. Only `p2` is subtracted,
so a park reason names that band and nothing wider. That is a subtraction and nothing more: home the work by fit exactly as above.
Every row the verb prints, and what `running` is derived from, is its own section
(`fabrika wire doc-section --heading "triage homes" < <skill-base>/contract.md`).

```bash
fabrika triage homes
```

```bash
fabrika triage enrich $issue_number --token <claim-token> <<'EOF'
…
EOF
```

For an epic, `fabrika triage enrich 4318 --epic` takes the pitch's five fields on that same stdin —
Problem / Arc / Appetite / Rabbit-holes / No-gos — and heads them `## Pitch` above the brief, which
it preserves verbatim for the planner; no *rewrite* goes above an epic's brief. The rewrite adds
real paths and function names over vague framing, and acceptance criteria that make "done" legible —
not a closed set, a `review-*` gate may append. The criteria block's grammar is the wire format's,
not this skill's ([`packages/fabrika-cli/src/wire/acceptance-criteria.ts`](../../../../packages/fabrika-cli/src/wire/acceptance-criteria.ts)):
`enrich` runs that reader over the body it composed and refuses a drifted block on exit `15` before
writing anything, naming the defect the reader found — so write the criteria and let the verb answer.
A rewrite carrying **no** criteria block is still accepted, where none is warranted. The stdin
grammar, the epic pitch's five fields and every exit the verb refuses on live in its section
(`fabrika wire doc-section --heading "triage enrich" < <skill-base>/contract.md`).

**An ordering you state must already be an edge.** ADR
[0301](../../../../.decisions/0301-blocked-by-graph-is-the-carrier.md) makes the native `blocked_by`
graph the one carrier of "do not start this yet", so a rewrite saying "Blocked. Do not start until
#N" over a graph with no such edge ships an issue `build pick` admits and no lane can build — #6663
did exactly that and cost a lane a claim. `enrich` scans the region it composed and refuses on `20`,
writing nothing. **There is no override**, and the refusal names both ways out: wire the edge in step
7 with `--blocked-by`, then re-send, or reword so the body states no ordering it does not own. Two
things it deliberately does not red on: a phrase in a third-person voice ("it is already blocked on
#N" reports another issue's prerequisite), and a `#N` that is a **pull request** — ADR 0301 names a
blocking PR by the issue its merge closes, so there is no edge to wire. What counts as a statement —
and why it is narrow — is that verb's section
(`… --heading "A stated ordering must be an edge, and 20 is the refusal"`).
**No invention**: enrich from what you found, keep
the uncertainty the original had, and mark your own reads `Triage note:`. On a **re-type, rewrite the
body's criteria to the new type** — stale criteria under a re-scoped comment ship a misleading spec.
Done when every claim traces to something you read.

## 7 — Price it, stamp it, and say who picks it up

Run the value bar first — it is stated once, in step 8 on the `agent` kill route, and a ticket that
fails it earns a kill rather than a price. Then price what survives, on the work's own
merit: `p0` for ship-work and fires, `p1` for what you would genuinely pull next, **`p2` is the
default** and most of a healthy backlog. A roadmap row confers no band either way.

```bash
fabrika triage apply $issue_number --type bug --priority p2 --ready-for agent --home 47 --token <claim-token>
```

A standing lane takes `--lane wayfinder:backlog` (or `axis:pipeline-hardening`) **instead of**
`--home`, never both — a lane label is not a milestone number, and putting a milestone on a
lane-exempt issue is banned outright.

**Repeatable `--blocked-by <n>` writes the prerequisites as native graph edges** — the only triage
route to them, and where an ordering belongs. Pass one per issue this one waits on
(`--blocked-by 6661 --blocked-by 6662`); the verb resolves each target's internal id, skips the edges
already live so a re-run is safe, and reads the whole set back as the machine line's last column. A
target that does not exist refuses on `7` before any label is written, and a target that is a **pull
request** refuses on `21` — ADR 0301 names a blocking PR by the issue its merge closes, so pass that
issue's number. This is the escape step 6's `20` names, so an ordered slice set is stamped
edges-first and its rewrite then passes.

**That last column reports this run, not the graph.** It is empty on every call that passed no
`--blocked-by`, whatever the issue actually waits on, because the verb reads the dependency endpoint
only when the flag is there. Read prerequisites with `fabrika build eligible <n>`, never off an empty
column here.

Which facets this verb owns and may remove, and the label
vocabulary it treats as a precondition, are its own sections
(`fabrika wire doc-section --heading "triage apply" < <skill-base>/contract.md`, then
`--heading "The owned facets — what apply may remove"`).

**`--ready-for` is a different question from readiness.** `status:triaged` says the ticket is ready;
`ready-for:` says ready *for whom*. Send it to `agent` when the work is specified well enough to
execute cold; to `human` when the deliverable is a judgment — a `type:decision`, an authoring brief,
anything resting on a product call nobody has made. Get it wrong and a document written for a human
lands in a builder's candidate pool.

**A `type:decision` goes to `agent` when the choice is already recorded on it.** Send it there when
the issue carries a founder ruling comment that made the call: the deliverable is then transcription
— write that ruling into the ADR or amendment it names — and transcription executes cold (ADR
[0300](../../../../.decisions/0300-a-cited-ruling-makes-a-decision-buildable.md)). This is the stamp
`build`'s citation arm reads; without it the arm is unreachable and the ruling costs another human
round-trip. No such comment, and the default above stands: `human`. You cite the comment rather than
judging the question settled yourself, and a ruling that left a gap open is still a judgment, so it
stays `human`. An issue already parked on `human` needs no triage re-run to come back:
`fabrika decision rule <n> --cites <url>` is how a control-plane human records the ruling and flips
the audience, and its contract is that verb's `--help`, not this page.

**`--ready-for agent` requires a criteria block on every type but `epic`.** The verb reads the live
body through the same wire reader every grader downstream reads, and refuses on `16` — writing no
label — when the block is absent or malformed: that label promises a builder can pick the issue up
cold, and the block is what the promise is made of. Author one back in step 6 and re-stamp; a level
drift is `triage repair-criteria`'s. `--type epic` is exempt because an epic's criteria arrive per
child from the plan ledger, and `--ready-for human` is never asked for one.

**Do not assert control-plane scope.** `cp-classify` routes it and CODEOWNERS enforces it at merge;
asserting it here routes a lane around an approval that never fires.

Done when the verb read back exactly one `type:`, one `p`, `status:triaged`, `ready-for:`, a home,
and every `--blocked-by` edge you asked for.

## 8 — The two outcomes that are not "triaged"

```bash
fabrika triage provenance $issue_number
```

Provenance decides what may be closed, and it has **two agent signals**: the `Filed by an agent`
footer, or an author in the operator set `$FABRIKA_OPERATOR_ACCOUNTS` names — the operator's own
filing is agent-reported footer or not, because footer-absence there is the emitter gap, not a human
author. Footer-absence from anyone else is still human-owned. How each signal is read, and what the
verb refuses to infer, is its section
(`fabrika wire doc-section --heading "triage provenance" < <skill-base>/contract.md`).

- **`human`** you cannot act on → park it; it leaves the queue on `status:needs-info`, **never
  closed**. When in doubt treat it as human: ignoring a person costs more than a cheap agent issue.
  The park note's stdin grammar and the facets the verb removes are its section
  (`fabrika wire doc-section --heading "triage park" < <skill-base>/contract.md`).

```bash
fabrika triage park $issue_number --token <claim-token> <<'EOF'
…
EOF
```

- **`agent`** and unsalvageable, duplicate, or failing the value bar below → kill it, which closes it
  not-planned carrying `closed-by-triage` and no triage status label — the verb strips the status it
  arrived on, so you never hand-delete `status:needs-triage` after a kill. **`--confirm` is you attesting that salvage was genuinely
  attempted**: a human-invoked `/report` carries the same agent footer, so footer presence alone
  never licenses a close. Killing a duplicate takes `--duplicate-of <survivor>`, which folds this
  issue's content into that one before closing; without it the content is simply lost. What the fold
  copies and what closing writes is the verb's section
  (`fabrika wire doc-section --heading "triage kill" < <skill-base>/contract.md`).

```bash
fabrika triage kill $issue_number --confirm --duplicate-of 4290 --token <claim-token> <<'EOF'
…
EOF
```

**The value bar.** An issue can be correct, well-written, and still worth nothing. This is the bar
the founder's own sweeps run on ([#4634](https://github.com/kamp-us/phoenix/issues/4634)), and it
kills an agent-filed issue when any one of five clauses holds:

- **process ceremony** — the deliverable is a record nobody then acts on, a decision written down for
  its own sake;
- **self-generated churn** — refactor or build work we filed against our own output with no behaviour
  change: restated vocabulary, a duplicated list tidied, a docblock or sample-transcript nit, a doc
  sentence that omits one clause of a check that already works;
- **hardening with no incident** — *has this ever failed in production?* This clause is a factual
  test, not a taste call, and a "no" kills it. A missing unit test for a refusal that already works
  is this clause; so is nice-to-have telemetry or cost reporting for a cost nobody is paying;
- **superseded** — something already landed, or already ruled, makes it moot;
- **duplicate of its parent** — the parent's scope already covers it.

Those examples are verdicts, not hypotheticals: a sweep on 2026-08-18 killed twelve of thirty-five
triaged `p2`s, and every one of them landed in a clause above. The bar reaches agent-filed work only
— **a human filing is parked, never killed**, however cleanly it fits a clause, with one exception:
a `--duplicate-of` fold closes it whatever its provenance
([#6070's ruling](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454)), because
a fold moves the content into the survivor instead of discarding it. Every other close of a human
filing still refuses on `12`.

Done when the issue has left the queue by exactly one route.

## Sweeping the queue

```bash
fabrika triage queue
```

**Only `empty` ends a sweep** — a proven-empty queue and a failed read are different answers, and
which is which is the verb's section
(`fabrika wire doc-section --heading "triage queue" < <skill-base>/contract.md`; the codes it shares
with every verb above are `--heading "The shared exit taxonomy"`). Then
report one line per issue: outcome, type, priority, home, audience, **repo-relative paths only**.
