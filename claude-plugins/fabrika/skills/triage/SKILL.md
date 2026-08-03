---
name: triage
description: Turn one raw `status:needs-triage` issue into a single actionable unit a builder can pick up cold — classified, enriched from the code, priced, homed, and addressed to whoever picks it up. Trigger on "/triage", "triage the queue", "triage issue #N", "process needs-triage", "classify these issues", and whenever someone asks to make the backlog actionable or pickable. This is the guardrail between raw intake and pickable work: nothing reaches a builder without passing through here, so a wrong-but-well-formed label written here travels downstream unchallenged. Done when the issue carries exactly one `type:`, one `p`, `status:triaged`, one `ready-for:`, and a home — or has left the queue as `status:needs-info` or a killed agent filing.
---

# triage

You are the guardrail. **The failure that matters is not a missing label — it is a confident wrong
one**, indistinguishable from a correct one once it lands: #4227 asserted a control-plane scope the
contract excludes and a lane was planned around it; #4285 stamped an issue that read fully triaged
while carrying no priority at all. Each step makes its answer checkable, not merely well-formed. You
have full rewrite authority, **salvage first**, and never close a human's issue.

## 1 — Claim it before you mutate it

Two sweeps that picked #N off one snapshot both rewrite its body; the second `PATCH` silently wins.

```bash
fabrika triage claim 4312
```

`won` means this session holds it. Done when it printed `won`; on anything else, move on.

## 2 — Read the issue, then read the code it is about

Never classify from the title. Read the body, then read enough of the repo to say in your own words
what this is about. **Where the issue rests on a falsifiable claim about the repo, check it against
source before enriching on top of it** — a summary of a contract is not the contract, and grounding
is what caught a wrong premise three times over in #4133. A hand-filed issue never ran a dedup
check, so this seam is also where a human-filed duplicate is caught:

```bash
fabrika report dedup --query "sozluk definition editor loses focus after save" --exclude 4312
```

Read `candidates` yourself — shared vocabulary is not a shared observation. `none` is proven;
`indeterminate` is a non-check, so re-query. A duplicate routes by who filed it (step 7). Done when
you can state the issue from the code and the dedup outcome is read.

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
  stays one; `write-code` owns that collapse, and re-typing in anticipation was rejected (ADR 0070).
- **feature vs epic** — judge the *real* deliverable. **Do not invent a v1 scope to make an epic fit
  a PR**; if you must carve the work down to call it a feature, it is an epic and your carve-out is
  its first child. Tells: missing prerequisite infrastructure, implied new surfaces, and your own
  hedging — "if this balloons, split X out" is the epic boundary talking.

Done when one type holds and you can name the question that excluded its nearest neighbour.

## 4 — Split a bundle into single units

Two problems different agents could work at different times, with different types, are a bundle; two
facets of one change are not.

```bash
fabrika triage split 4312 --title "Editor loses focus after save" < child-body.md
```

Done when every unit is separately pickable. **A human-filed original always stays one of the
units** — only an agent filing may be left as an empty husk and killed, because a human's issue is
never closed and a husk parked on `status:needs-info` is a question nobody can answer.

## 5 — Enrich: rewrite on top, original preserved beneath

```bash
fabrika triage enrich 4312 < enriched-body.md
```

Preserves the original beneath your rewrite, redacting machine-local paths out of it (#3019). Pass
`--epic` — which takes no stdin — to wrap in place instead: an epic's brief is consumed verbatim
downstream, so nothing is written above it.

The rewrite adds real paths and function names in place of vague framing, and acceptance criteria
that make "done" legible — the seed of a list a `review-*` gate may append to (ADR 0079), not a
closed set. **No invention**: enrich from what you found, keep the uncertainty the original had, and
mark your own reads `Triage note:`. On a **re-type, rewrite the body's criteria to the new type**; a
re-scope landing in a comment while stale criteria sit in the body ships a misleading spec (#2165 →
#2180). Done when every claim traces to something you read.

## 6 — Price it, home it, and say who picks it up

Ask ADR 0202's question first — *if the founder never learned this ticket existed, would anything
visibly change?* A "no" earns no home by default; it earns a kill. Then price on the work's own
merit: `p0` for ship-work and fires, `p1` for what you would genuinely pull next, **`p2` is the
default** and most of a healthy backlog. A roadmap row confers no band either way (ADR 0219).

```bash
fabrika triage homes
fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47
```

Take an existing one: **triage never creates a milestone** (ADR 0072 §3), and `wayfinder:backlog` is
bounded to genuine fog rather than work you would rather not decide about.

**`--ready-for` is a different question from readiness.** `status:triaged` says the ticket is ready;
`ready-for:` says ready *for whom* (#4780). Send it to `agent` when the work is specified well enough
to execute cold; to `human` when the deliverable is a judgment — a `type:decision`, an authoring
brief, anything resting on a product call nobody has made. Getting this wrong is how a document
meant for a human lands in a builder's candidate pool (#4693).

**Lane-entering work — an epic, or a parentless feature — needs its home chosen back in step 5.** It
carries a drafted `## Pitch` whose `Arc` *is* that home, the pitch lives in the body, and
`pitch-guard` fires the moment `apply` stamps `status:triaged` — so a pitch written after this step
is one that arrives too late. Draft it; **only the founder approves one.**

**Do not assert control-plane scope.** `cp-classify` routes it and CODEOWNERS enforces it at merge;
#4227 is a triage note that contradicted a settled ruling and routed a lane around an approval that
never fires. Homing and pitch are the same shape — each is enforced by a CI guard firing on the very
label this verb applies, so state the expectation and let the guard answer.

Done when the verb read back exactly one `type:`, one `p`, `status:triaged`, one `ready-for:`, and a
home.

## 7 — The two outcomes that are not "triaged"

```bash
fabrika triage provenance 4312
```

Filing provenance, not authorship, decides what may be closed (ADR 0159) — every report-filed issue
shows the same author. An unreadable body answers `human`, never `agent`.

- **`human`** you cannot act on → `fabrika triage park 4312`, questions on stdin; it leaves the queue
  on `status:needs-info`, **never closed**. When in doubt treat it as human: ignoring a person costs
  more than an agent issue sitting cheap.
- **`agent`** and unsalvageable, duplicate, or moving nothing forward →
  `fabrika triage kill 4312 --confirm`, reason on stdin. It folds a duplicate's content into the
  original **through the same redaction the enrich path uses** — v1 redacted one re-emit path and not
  this one — then closes not-planned with `closed-by-triage`. **`--confirm` is you attesting that
  salvage was genuinely attempted**: a human-invoked `/report` carries the same agent footer, so
  footer presence alone never licenses a close (ADR 0159). The verb refuses without it.

Done when the issue has left the queue by exactly one route.

## Sweeping the queue

```bash
fabrika triage queue
```

**Only `empty` ends a sweep** — a proven-empty queue and a failed read are different answers, and v1
terminated on the second while reporting the first. Then report one line per issue: outcome, type,
priority, home, audience. **Hold the ledger to the same rule as the bodies — repo-relative paths
only**, so nobody has to re-scrub it before relaying.
