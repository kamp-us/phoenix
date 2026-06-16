---
name: triage
description: Process the GitHub triage queue — classify, enrich, prioritize, split, or close issues labeled status:needs-triage on the configured target repo. Trigger on "triage the queue", "triage issue #N", "process needs-triage", "classify these issues", "/triage", or whenever you're asked to make the backlog actionable. This is the guardrail between raw intake (the report skill) and pickable work (write-code): nothing reaches a write-code agent without passing through here.
---

# triage

You are the guardrail. Raw issues land in `status:needs-triage` — filed by agents
via the `report` skill, or free-form by humans. Your job is to turn each one into a
single, actionable, correctly-typed, prioritized unit that a `write-code` agent can
pick up cold and trust — or to close it with an audit trail if it can't be salvaged.

You have **full rewrite authority**. Severity and priority are *your* call, not the
reporter's. Splitting a bundle is in your mandate. But you are **salvage-first,
kill-last**: enrich before you close, and never close a human's issue at all.

## The mandate, per issue

For each `status:needs-triage` issue, you produce exactly one of three outcomes:

1. **Triaged** — classified, enriched, prioritized, labeled `status:triaged`. The
   normal path. (A bundle is split first; each resulting unit is triaged.)
2. **Needs-info** — a human-filed issue you can't act on as-is. Labeled
   `status:needs-info` with a comment asking specific questions. **Never closed.**
3. **Closed not-planned** — an unsalvageable *agent*-filed issue. Closed with a
   reason comment and `closed-by-triage`. Last resort, never for human issues.

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL
issue queries. Every read and write goes through `gh api`. This is not a style
preference; GraphQL calls error out on this org.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every
`gh api` call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run
per the shared contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

List the queue:

```bash
gh api "repos/$REPO/issues?state=open&labels=status:needs-triage&per_page=100" \
  --jq '.[] | "#\(.number) (\(.user.login)) \(.title)"'
```

---

## Step 0 — Claim the issue before you mutate it (concurrent-sweep guard)

Triage sweeps run concurrently — the same several accounts that file `report` agents
also run triage sweeps. Two simultaneous sweeps that both picked #N off the opening
snapshot will **both** rewrite-on-top its body (Step 4, a last-write-wins `PATCH` — one
sweep's enrichment silently clobbers the other's, no error, the labels still read
triaged) and **both** split the same bundle (Step 3, producing duplicate children). The
Step 3 pre-create re-query guards against a *report agent* having filed the same
observation; it does **not** guard against a *sibling sweep* mutating the same issue in
the same window. So claim #N before you touch it.

**Claim by self-assigning — the same detect-and-tiebreak `write-code` uses** (Step 3
there; the shared semantics are pinned in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7). Assignee is
last-write-wins, not compare-and-swap, so a bare `POST` self → re-read is a TOCTOU, not a
lock; the protocol below is detect-and-tiebreak, **not** mutual exclusion. Run it
**per issue**, immediately before any mutation (split, rewrite, or label):

```bash
ME=$(gh api user --jq '.login')

# Rule 0 — defer to a pre-existing owner. If #N is already claimed (by a sibling sweep,
# or — see the release note below — by a write-code agent that picked an already-triaged
# issue), back off WITHOUT POSTing and move to the next issue. A fresh arrival never
# evicts an owner that was there before it.
PRE=$(gh api repos/$REPO/issues/<N> --jq '[.assignees[].login] | sort | join(" ")')
[ -n "$PRE" ] && continue   # already claimed → skip this issue, take the next

# POST self; capture the FULL assignees list the write returns (one observable write).
ASSIGNEES=$(gh api -X POST repos/$REPO/issues/<N>/assignees \
  -f "assignees[]=$ME" --jq '[.assignees[].login] | sort | join(" ")')

# Provisional tiebreak among co-racers: min-login. The POST echo only DETECTS a race
# (staggered co-racers see different sets and both may compute themselves min); the
# checkpoint GET below RESOLVES it. See §7 for the full derivation.
WINNER=$(printf '%s\n' $ASSIGNEES | head -n1)
if [ "$WINNER" = "$ME" ]; then
  for a in $ASSIGNEES; do
    [ "$a" = "$ME" ] && continue
    gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$a"
  done
  # CHECKPOINT — re-read canonical state (a fresh GET, not the stale POST echo) and
  # re-confirm I am still min(assignees). This is what resolves the race; do not prune it.
  STILL=$(gh api repos/$REPO/issues/<N> --jq '[.assignees[].login] | sort | join(" ")')
  [ "$(printf '%s\n' $STILL | head -n1)" = "$ME" ] || {
    gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME"; continue; }
  # claim won and confirmed → triage this issue (Steps 1–6), then RELEASE in Step 6
else
  # lost the tiebreak: self-clean and take the next issue (do NOT triage — do NOT co-occupy)
  gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME"
  continue
fi
```

**You MUST release the claim when you finish triaging** (Step 6) — triage's claim is a
*sweep-scoped mutex*, not the durable ownership `write-code`'s claim is. This is the one
place triage's claim differs from `write-code`'s, and it's load-bearing: `write-code`'s
picker (Step 1) **skips any issue with a non-null assignee**, so a triaged issue left
self-assigned by triage would be invisible to every `write-code` agent — triaged but
unpickable forever. Releasing closes that interaction: the issue leaves triage `status:triaged`
**and unassigned**, exactly what the picker expects. (`needs-info` and `closed` outcomes
release too — see Step 6.)

---

## Step 1 — Read the issue and its context

Don't classify from the title. Read the body, then read enough of the codebase to
know what the issue is actually about — the files it names, the ADR/pattern docs it
cites, the related issues. That context is what lets you classify correctly, write a
faithful enrichment, and pick a real priority. A triage that skips the codebase
produces labels nobody downstream can trust.

Note **who filed it** and **what shape it's in** — you'll need both for the
human-vs-agent judgment (Step 5) and the classification (Step 2).

---

## Step 2 — Classify into exactly ONE of six types

Every issue gets exactly one `type:*`. The boundaries are locked — when an issue
seems to straddle two, the distinguishing question in each definition is the
tiebreaker. Apply the canonical label name (`type:bug`, etc.).

| Type | `type:*` label | Definition — the issue is this when… |
|---|---|---|
| **bug** | `type:bug` | **Behavior diverges from intent.** Something already built does the wrong thing. There's a "supposed to" being violated. |
| **feature** | `type:feature` | **A new capability, directly implementable.** It doesn't exist yet, the path to building it is clear, and it fits in a PR or a few. |
| **chore** | `type:chore` | **No behavior change.** Refactors, renames, dependency bumps, test hygiene, dead-code removal, doc edits. The observable behavior of the system is identical before and after. |
| **decision** | `type:decision` | **One question; the output is a recorded choice.** A fork in the road that needs settling (an ADR), not code. If the deliverable is "we decided X" rather than "we built X", it's a decision. |
| **investigation** | `type:investigation` | **An unknown; the output is knowledge.** Root cause is not yet understood. The deliverable is a diagnosis — *then* maybe a fix, a decision, or a new report. If you can't yet say what to build because you don't yet know what's wrong, it's an investigation. |
| **epic** | `type:epic` | **Too big for one PR; it spawns children.** Multiple questions and/or multiple implementable units under one umbrella. The deliverable is a plan plus sub-issues, not a single change. |

### The boundaries that actually bite

- **decision vs epic** — *one* question → decision; *many* questions, or
  questions-plus-buildable-children → epic. A design issue carrying five open
  questions and a v1 scope is an epic, not a decision.
- **bug vs investigation** — if the wrong behavior is understood and the fix is
  nameable, it's a bug. If you'd have to *investigate* to even say what's wrong (an
  intermittent hang, an unexplained exit code), it's an investigation. "Filed to
  investigate later" in the body is a strong tell.
- **chore vs feature** — does observable behavior change? Splitting a 1,600-line
  file with identical public surface is a chore. Adding a capability that wasn't
  there is a feature. A dependency bump that *enables* nothing new is a chore.
- **feature vs epic** — can one write-code agent finish it in a PR or two with a
  clear path? Feature. Does it need a plan and sub-issues first? Epic. Judge the
  *real* deliverable, not a shrunken one — **do not invent a "v1 scope" of your own
  to make an issue fit in a PR**; if you have to carve the work down to call it a
  feature, it's an epic and your carve-out is its first child. Tells that you're
  looking at an epic wearing a feature's clothes:
  - **Missing prerequisite infrastructure.** The capability depends on something
    that doesn't exist anywhere yet (an email provider, a moderation backend, a
    scheduled-job mechanism). "Path to building it is clear" is false by definition.
  - **The capability implies new surfaces.** A bookmark needs a saved-items view; a
    report button needs a review surface; a setting needs somewhere its effect shows.
    If acting on the capability requires UI/endpoints nobody has built, count those
    units.
  - **Your own enrichment hedges.** If you catch yourself writing "if this balloons,
    split the X part out" or "Y is explicitly out of scope for v1", that hedge is
    the epic boundary talking — classify accordingly instead of scoping around it.

When genuinely torn, pick the type that best describes the *deliverable* (recorded
choice / knowledge / code / plan-and-children) and note the call in the enrichment.

---

## Step 3 — Split bundled reports

Every open issue must be a **single actionable unit**. If a report bundles two (or
more) genuinely separate problems — two unrelated bugs, a bug plus a refactor, a
question plus a task — split it so each unit can be typed, prioritized, and picked
independently.

How to split:

1. **Decide it's really a bundle.** Two facets of *one* change are not a bundle
   (e.g. "rename the function and update its callers"). Two problems that could be
   worked by different agents at different times, with different types or
   priorities, are.
2. **Re-query before you create.** Report agents run concurrently with your sweep
   (several people run them, from their own accounts), so the queue you listed at
   the start is already stale. Immediately before creating *any* new issue — a
   split child or a follow-up you spotted while triaging — re-list
   `status:needs-triage` and keyword-search open issues for the same observation:

   ```bash
   gh api "repos/$REPO/issues?state=open&labels=status:needs-triage&per_page=100" \
     --jq '.[] | "#\(.number) \(.title)"'
   gh api "search/issues?q=repo:$REPO+is:issue+is:open+<keywords>" \
     --jq '.items[] | "#\(.number) \(.title)"'
   ```

   The two commands guard different failure modes — don't drop either: the label
   list is read-after-write consistent and catches an issue filed seconds ago; the
   search runs against GitHub's eventually-consistent index but covers older open
   issues that already left the queue. Join keywords with `+`
   (e.g. `…+is:open+retry+abort`) — raw spaces inside the quoted URL produce a
   malformed query.

   If an existing issue already covers it, enrich/triage that one instead of filing
   a twin. (This rule exists because a triage run once filed a duplicate of an issue
   that had landed in the queue minutes earlier.)
3. **Create one new issue per extra unit** via REST, each labeled
   `status:needs-triage` so it re-enters the queue (you'll triage the new ones on a
   later pass — or this same run — like any other). Give each a sharp single-unit
   title and a body that states the one problem, following the report skill's
   5-section shape where it fits (see [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)
   for the surrounding format conventions).
4. **Cross-link.** Each new issue references the original (`split from #N`), and you
   add a comment on the original listing the children (`split into #A, #B`). The
   reader can always trace a unit back to where it came from.
5. **Resolve the original.** Either keep it as one of the units (triage it normally,
   having spun the *other* units off) or, if it was purely a container with nothing
   left after splitting, close it not-planned with a `closed-by-triage` reason
   comment pointing at the children (the full close-out protocol — reason comment +
   `closed-by-triage` + `state_reason=not_planned` — is in Step 6). Don't leave an
   empty husk open.

```bash
gh api "repos/$REPO/issues" \
  -f title="<single-unit title>" \
  -f body="$BODY" \
  -f "labels[]=status:needs-triage"
# then cross-link via a comment on the original (Step 6 shows the comment call)
```

---

## Step 4 — Enrich and rewrite (rewrite-on-top, original preserved)

Thin issues become actionable by rewriting them from the codebase context you
gathered in Step 1. The structure is **rewrite on top, original verbatim below**, so
the issue is actionable *without losing provenance*:

```markdown
<your rewritten, enriched body — the actionable version a write-code agent reads first>

---

<details>
<summary>Original report (verbatim)</summary>

<the original body, byte-for-byte unchanged>

</details>
```

What the rewrite adds:

- **Sharper framing.** State the problem in terms of what's actually true in the
  codebase — the real file paths, the function names, the ADR/pattern docs, the
  related issues. Promote anything load-bearing the original buried.
- **Repo-relative paths only — never machine-local paths.** The body is a shared
  artifact, like a committed file: every path in your enrichment must be
  repo-relative (`apps/web/worker/…`, `.decisions/0044-….md`) or a dependency's
  package-internal module, resolvable by anyone who checks out the repo. **Never**
  write a path that only exists on the filer's machine — an absolute path
  (`/Users/…`), a home-dir clone (`~/code/…`, `~/.vault/…`), or a sibling-repo
  source tree. If you grepped a local dependency clone to find a seam, name the
  module by its in-package path, not the clone location. (Same rule the repo
  enforces for committed docs — it just extends to issue bodies and comments.)
- **Acceptance-shaped clarity.** Make "done" legible. For a typed-and-pickable issue
  the write-code agent shouldn't have to reverse-engineer what success looks like.
- **No invention.** Enrich from what you *found*, not what you wish were true. If the
  original is uncertain, keep the uncertainty — don't manufacture a false plan. Mark
  your additions as triage's read where it helps ("Triage note: …"). Scope-shrinking
  is invention too: don't write a reduced "v1 scope" into the body to make an epic
  look feature-sized (see the feature-vs-epic tells in Step 2) — scoping decisions
  belong to `plan-epic` and the owner, not triage.

Preserve the original **exactly** in the `<details>` block — it's the provenance
record and the reporter's unedited words. If the body has its own triple-backtick
code fences, the `<details>` block still nests them fine; don't re-indent or reflow
the original.

To get the original verbatim:

```bash
gh api "repos/$REPO/issues/<N>" --jq '.body' > /tmp/triage-original-<N>.md
```

Assemble the new body in a temp file and read it into `$BODY` so multi-line markdown,
backticks, and the nested fences survive the shell:

```bash
BODY="$(cat /tmp/triage-body-<N>.md)"
gh api -X PATCH "repos/$REPO/issues/<N>" -f body="$BODY"
```

**Epics are the exception — do not rewrite-on-top.** An epic's original content is
the *brief*, not superseded noise; the `plan-epic` skill appends its plan *below* the
untouched original (append-down, not rewrite-on-top — see the formats doc). For an
epic, classify and prioritize it, optionally add a short triage note as a comment,
but leave the body's original brief intact at the top. Do not bury it in a
`<details>`. (If an epic was filed truly threadbare, prefer `status:needs-info` over
mangling it.)

---

## Step 5 — The human-vs-agent judgment (who never gets auto-closed)

**Human-filed issues are never auto-closed.** A human capture gets grace; agent noise
gets filtered. This is a judgment call, not a protocol — you recognize a human filer,
you don't parse a flag.

**The account is not the tell — the shape is.** Every collaborator on this repo
(`usirin`, `cansirin`, …) files both ways: as a human in passing, and via `report`
agents running under their own account. So never treat "who filed it" as settling
the question; read the body.

Tells that an issue is **agent-filed** (the only kind you may close):

- **It carries the agent-report fingerprint.** The `report` skill files a
  recognizable shape: the five sections (*What I was doing / What I observed / Why
  it matters / Pointers / Suggested next step*) and a `<sub>Filed by an agent ·
  …</sub>` metadata footer. The literal **`Filed by an agent` marker is the
  invariant** — the footer's session/model/branch fields are best-effort and often
  absent (`footer.sh` silently drops what the environment doesn't expose), so don't
  treat a sparse footer as "fingerprint missing". The clean five-section structure
  backs the marker up.
- **Five sections but no footer is usually pipeline-made** — a triage split child
  (look for `split from #N` in the body or comments) or another skill's filing.
  Judge by provenance, not just shape: a split child traced to an agent-filed
  original is agent-filed.

Tells that an issue is **human-filed**:

- **It reads scrappy and free-form** — a quick thought, a one-liner, a question, an
  inconsistent shape. Humans file in passing; they don't fill in a template.
- **It lacks the agent fingerprint** — no `Filed by an agent` marker, no
  five-section shape, no pipeline provenance.

When in doubt, **treat it as human.** The cost of wrongly closing a human's issue
(they feel ignored) is worse than the cost of wrongly leaving an agent's issue open
(it sits in needs-info, cheap to revisit).

**For a human-filed issue you can't act on as-is:** apply `status:needs-info` (not a
type, not a priority, not triaged) and post a comment asking the *specific* questions
that would unblock triage. Specific, not generic — "Which file? What's the expected
behavior vs what you saw? Is this blocking anything?" beats "please add more detail".
You may still type a human issue if it's already clear; needs-info is only for the
ones you genuinely can't classify or act on yet.

**Needs-info leaves the queue:** remove `status:needs-triage` when you apply
`status:needs-info` (same DELETE call as the triaged path in Step 6). A parked
question must not re-surface in every sweep and queue listing; it re-enters the
queue when whoever answers swaps the labels back (`status:needs-info` →
`status:needs-triage`). It *does* still appear in the keyword-search half of the
pre-filing re-query, since it stays open — that's intentional, don't "fix" the
search command to filter it out: a report agent finding a needs-info twin should
comment there rather than file anew.

---

## Step 6 — Prioritize, label, and close out

### Assign a priority

Every triaged issue gets exactly one of `p0` / `p1` / `p2`. Priority is *your*
judgment of urgency-and-impact, deliberately coarse — it sets write-code's pick order
(highest bucket first, oldest first within a bucket), so it only has to be
*directionally* right, not a precise ranking.

| Priority | Use when… |
|---|---|
| **`p0`** | **Highest.** Drop-everything: actively breaking something people rely on, blocking other work, a data-loss or security risk, or a release gate. If it's not really urgent, it's not p0 — reserve it so the bucket stays meaningful. |
| **`p1`** | **Medium.** Real and worth doing soon, but nothing is on fire. The default for solid, actionable work that isn't an emergency. |
| **`p2`** | **Lowest.** Nice-to-have, cleanup, "don't forget to reconsider" trackers, low-impact refactors, deferred investigations. Real work, no time pressure. |

Most of a healthy backlog is `p1`/`p2`. When unsure between two buckets, pick the
lower one — over-escalation erodes the signal faster than under-escalation.

### Apply the labels (triaged path)

The canonical `type:*` / `p*` / `status:*` label set is defined by the label
bootstrap / formats contract ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)) —
triage *applies* labels from that existing set, and must never silently auto-mint an
off-spec label via `POST .../labels`.

A triaged issue carries: the one `type:*`, one `p*`, and `status:triaged`. Remove
`status:needs-triage` so it leaves the queue. Do it in REST calls:

```bash
# add the type, priority, and triaged status
gh api "repos/$REPO/issues/<N>/labels" \
  -f "labels[]=type:chore" -f "labels[]=p2" -f "labels[]=status:triaged"
# remove the needs-triage label — pass the BARE name; gh api encodes the path segment
# (don't pre-encode the colon as %3A, or gh double-encodes it to %253A → spurious 404)
gh api -X DELETE "repos/$REPO/issues/<N>/labels/status:needs-triage"
```

A `404 "Label does not exist"` on that DELETE is harmless **only** in one known case:
the issue never carried `status:needs-triage` to begin with — a pre-bootstrap backlog
issue that predates the label, which you may triage directly by number. In that case
the label is already absent, so the goal (issue out of the queue) is met. Do **not**
blanket-`|| true` the call: a 404 on an issue that *did* carry the label means the
removal silently failed and the issue is still in the needs-triage queue while looking
triaged. So if you're not certain it's the pre-bootstrap case, verify the label is
actually gone after the call rather than swallowing the error:

```bash
gh api "repos/$REPO/issues/<N>" \
  --jq '[.labels[].name] | index("status:needs-triage") // "removed"'
# expect "removed"; anything else means the label is still on the issue — investigate
```

`status:triaged` is an explicit signature only *you* apply — it tells write-code the
issue was actually reviewed. Never let a type label alone stand in for it; a
hand-slapped `type:*` with no triaged status must not look pickable.

### Close not-planned (kill, last resort, agent issues only)

Close an issue **only** when it's an *agent-filed* issue that is genuinely
unsalvageable — a duplicate of an existing issue, an observation that's no longer true
(the code moved on), a non-actionable note with nothing to enrich into, or noise.
Salvage first: if there's a real unit hiding in it, enrich and triage it instead.

Every kill is auditable and reversible. Always:

1. **If the reason is "duplicate of #M": preserve the loser's content on the
   survivor first.** A bare cross-link is not enough — the closed issue often
   carries context the survivor lacks (an independent verification, extra pointers,
   a sharper acceptance idea). Copy the duplicate's full body **verbatim** into a
   comment on #M, wrapped in a `<details><summary>#N (closed duplicate) — full
   body</summary>…</details>` block, and fold anything load-bearing into #M's
   enrichment. Nothing a reporter wrote should require clicking into a closed issue
   to read.
2. Post a **reason comment** — *why* it's unsalvageable, specifically (e.g. "Duplicate
   of #33, which already tracks this hang" or "The function this references was
   removed in #30; no longer applicable"). One sentence of real reasoning, so the
   maintainer reviewing kills can judge it.
3. Apply `closed-by-triage` so every kill shows up in one query.
4. Close as **not planned** (state `closed`, reason `not_planned`).

```bash
# step 1 only when closing as a duplicate of #M:
gh api "repos/$REPO/issues/<N>" --jq '.body' > /tmp/dup-<N>.md   # then wrap in <details> and:
gh api "repos/$REPO/issues/<M>/comments" -f body="$(cat /tmp/dup-comment-<N>.md)"
# steps 2-4, every kill:
gh api "repos/$REPO/issues/<N>/comments" -f body="Closing not-planned: <specific reason>."
gh api "repos/$REPO/issues/<N>/labels" -f "labels[]=closed-by-triage"
gh api -X PATCH "repos/$REPO/issues/<N>" -f state=closed -f state_reason=not_planned
```

The maintainer audits all kills with one query, so over-closing is caught and
reopened cheaply:

```bash
gh api "repos/$REPO/issues?state=closed&labels=closed-by-triage" \
  --jq '.[] | "#\(.number) \(.title)"'
```

### Release the claim (every outcome)

Once the issue has reached its outcome — triaged, needs-info, or closed — **remove your
self-assignment** so the claim doesn't outlive the sweep. This is mandatory on the
triaged path (otherwise the issue is `status:triaged` but unpickable — `write-code`'s
picker skips any non-null assignee, Step 0). Do it on the other two paths as well, for
consistency: a parked `needs-info` issue or a closed one should carry no stray triage
claim. The DELETE is idempotent — a 404 means it was already unassigned, which is fine.

```bash
ME=$(gh api user --jq '.login')
gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME" 2>/dev/null || true
```

(A `closed-by-triage` issue is closed *and* unassigned; a needs-info issue is parked with
`status:needs-info`, no triage claim. Only a triaged issue stays open, and it must be
unassigned to be pickable.)

---

## Running the queue

You can triage one named issue (`triage issue #34`) or sweep the whole queue. When
sweeping:

1. List `status:needs-triage` (the snippet at the top).
2. For each issue, **claim it first (Step 0)** — a concurrent sibling sweep may have
   picked the same issue off the same snapshot, so claim-or-skip before you mutate it. If
   the claim backs off (already claimed), move to the next issue. Then triage the claimed
   issue through Steps 1–6, **releasing the claim** at the end (Step 6, Release the claim).
3. If you split a bundle, the new children re-enter `status:needs-triage` — pick them
   up on the same sweep or a follow-up; they're triaged (claim → Steps 1–6 → release)
   like any other issue.
4. **Re-list the queue before declaring the sweep done.** Report agents file
   concurrently, so issues land mid-sweep; a sweep that only processes the opening
   snapshot routinely leaves fresh arrivals behind. An issue currently *claimed* by a
   sibling sweep still shows `status:needs-triage` (the claim is an assignee, not a
   label), so it reappears in this listing; Step 0's Rule-0 back-off skips it while the
   sibling holds it, and once that sweep releases, a later pass picks it up. Loop until
   the listing comes back empty of issues you can claim — every *completed* outcome
   (triaged / needs-info / closed) removes `status:needs-triage`, so a listing with
   nothing left to claim is the complete termination test.
5. Report a short ledger back: per issue, the outcome (type+priority+triaged /
   needs-info / closed) in one line each. Don't narrate every REST call — the labels
   and comments on the issues are the durable record.

## Conventions

This skill is one of a suite (`report` → **`triage`** → `plan-epic` → `review-plan` →
`write-code` → `review-code` → `ship-it`) that turns GitHub issues into an agent-operable
pipeline. The shared label semantics and the body/comment/dependency formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). You consume exactly
the issues the `report` skill files (recognize its 5-section + metadata-footer shape —
Step 5), and you hand `status:triaged` issues off to `plan-epic` (epics) and
`write-code` (everything else — a standalone issue is pickable straight from your gate;
an epic's children become pickable only after `plan-epic` plans them and `review-plan`
flips them `status:planned → status:triaged`).
