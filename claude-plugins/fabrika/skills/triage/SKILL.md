---
name: triage
description: Turn one raw `status:needs-triage` issue into a single actionable unit a builder can pick up cold — classified, enriched from the code, priced, homed, and addressed to whoever picks it up. Trigger on "/triage", "triage the queue", "triage issue #N", "process needs-triage", "classify these issues", and whenever someone asks to make the backlog actionable or pickable. This is the guardrail between raw intake and pickable work: nothing reaches a builder without passing through here, so a wrong-but-well-formed label written here travels downstream unchallenged. Done when the issue carries exactly one `type:`, one `p`, `status:triaged`, one `ready-for:`, and a home — or has left the queue as `status:needs-info` or a killed agent filing.
---

# triage

You are the guardrail. **The failure that matters is not a missing label — it is a confident wrong
one**, indistinguishable from a correct one once it lands. Each step makes its answer checkable, not
merely well-formed. You have full rewrite authority; **salvage first**.

## 1 — Claim it before you mutate it

```bash
fabrika triage claim 4312
```

Done when it printed `won` — that means this session holds it; on anything else, move on.

## 2 — Read the issue, then read the code it is about

Never classify from the title. Read the body, then read enough of the repo to say what this is about
in your own words. **Check any falsifiable claim it rests on against source before enriching on top
of it** — a summary of a contract is not the contract. A hand-filed issue skipped dedup:

```bash
fabrika report dedup --query "sozluk definition editor loses focus after save" --exclude 4312
```

Read `candidates` yourself — shared vocabulary is not a shared observation; `indeterminate` is a
non-check, so re-query. A duplicate routes by who filed it (step 8). Done when you can state the
issue from the code and the dedup outcome is read.

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

Done when one type holds and you can name the question that excluded its nearest neighbour.

## 4 — Attach before you mint

**Search the board for an open epic or issue on the same surface before you leave this as standalone
work.** Step 2's dedup asks whether this exact observation is already filed; this asks the wider
question — is there already a ticket that *owns this surface* and should absorb it? Query on the
surface, not on your issue's wording:

```bash
fabrika report dedup --query "sozluk definition editor keyboard focus" --exclude 4312
```

Read the candidates yourself and take the cheapest true route:

- **An open epic or issue already owns this surface** → **fold in and close**, which is the preferred
  outcome. Add this issue's content to the survivor, then close this one against it so the trail runs
  both ways — the survivor carries the content, this issue points at the survivor. `fabrika triage
  kill 4312 --confirm --duplicate-of 4290` is the folding route, and it is only open to an agent
  filing (step 8); for a human filing, add the content to the survivor by hand and carry on triaging
  this one, since a human filing is never closed here.
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
fabrika triage split 4312 --title "Editor loses focus after save" <<'EOF'
…
EOF
```

Done when every unit is separately pickable. **A human-filed original always stays one of the
units** — only an agent filing may be left as an empty husk and killed, because a husk parked on
`status:needs-info` is a question nobody can answer.

## 6 — Home it, then enrich: rewrite on top, original preserved beneath

**Every issue leaves with a home** — an open milestone, or one of the two standing lanes.
Lane-entering work (an epic, or a parentless feature) additionally carries a `## Pitch` whose `Arc`
*is* that home — inside your rewrite for a feature, on stdin for an epic — and **only the founder
approves a pitch**. Take an existing home: **triage never creates a milestone**, and
`wayfinder:backlog` is bounded to genuine fog rather than work you would rather not decide about.

```bash
fabrika triage homes
```

```bash
fabrika triage enrich 4312 <<'EOF'
…
EOF
```

For an epic, `fabrika triage enrich 4318 --epic` takes the pitch's five fields on that same stdin —
Problem / Arc / Appetite / Rabbit-holes / No-gos — and heads them `## Pitch` above the brief, which
it preserves verbatim for the planner; no *rewrite* goes above an epic's brief. The rewrite adds
real paths and function names over vague framing, and acceptance criteria that make "done" legible —
not a closed set, a `review-*` gate may append. **No invention**: enrich from what you found, keep
the uncertainty the original had, and mark your own reads `Triage note:`. On a **re-type, rewrite the
body's criteria to the new type** — stale criteria under a re-scoped comment ship a misleading spec.
Done when every claim traces to something you read.

## 7 — Price it, stamp it, and say who picks it up

Ask the kill question first — *if the founder never learned this ticket existed, would anything
visibly change?* A "no" earns no home by default; it earns a kill. Then price on the work's own
merit: `p0` for ship-work and fires, `p1` for what you would genuinely pull next, **`p2` is the
default** and most of a healthy backlog. A roadmap row confers no band either way.

```bash
fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47
```

A standing lane takes `--lane wayfinder:backlog` (or `axis:pipeline-hardening`) **instead of**
`--home`, never both — a lane label is not a milestone number, and putting a milestone on a
lane-exempt issue is banned outright.

**`--ready-for` is a different question from readiness.** `status:triaged` says the ticket is ready;
`ready-for:` says ready *for whom*. Send it to `agent` when the work is specified well enough to
execute cold; to `human` when the deliverable is a judgment — a `type:decision`, an authoring brief,
anything resting on a product call nobody has made. Get it wrong and a document written for a human
lands in a builder's candidate pool.

**Do not assert control-plane scope.** `cp-classify` routes it and CODEOWNERS enforces it at merge;
asserting it here routes a lane around an approval that never fires.

Done when the verb read back exactly one `type:`, one `p`, `status:triaged`, `ready-for:`, a home.

## 8 — The two outcomes that are not "triaged"

```bash
fabrika triage provenance 4312
```

Provenance decides what may be closed, and it has **two agent signals**: the `Filed by an agent`
footer, or an author in the operator set `$FABRIKA_OPERATOR_ACCOUNTS` names — the operator's own
filing is agent-reported footer or not, because footer-absence there is the emitter gap, not a human
author. Footer-absence from anyone else is still human-owned.

- **`human`** you cannot act on → park it; it leaves the queue on `status:needs-info`, **never
  closed**. When in doubt treat it as human: ignoring a person costs more than a cheap agent issue.

```bash
fabrika triage park 4312 <<'EOF'
…
EOF
```

- **`agent`** and unsalvageable, duplicate, or moving nothing forward → kill it, which closes it
  not-planned carrying `closed-by-triage`. **`--confirm` is you attesting that salvage was genuinely
  attempted**: a human-invoked `/report` carries the same agent footer, so footer presence alone
  never licenses a close. Killing a duplicate takes `--duplicate-of <survivor>`, which folds this
  issue's content into that one before closing; without it the content is simply lost.

```bash
fabrika triage kill 4312 --confirm --duplicate-of 4290 <<'EOF'
…
EOF
```

Done when the issue has left the queue by exactly one route.

## Sweeping the queue

```bash
fabrika triage queue
```

**Only `empty` ends a sweep** — a proven-empty queue and a failed read are different answers. Then
report one line per issue: outcome, type, priority, home, audience, **repo-relative paths only**.
