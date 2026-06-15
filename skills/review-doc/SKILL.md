---
name: review-doc
description: Verify a doc/knowledge PR against its linked issue's acceptance criteria — plus a doc-hygiene checklist — before it merges. The doc-artifact twin of review-code in the configured target repo's pipeline. Trigger on "review this doc PR", "review-doc #N", "gate the ADR PR", "verify the docs on #N before merge", "run review-doc", "does this ADR/pattern PR meet its acceptance criteria", or whenever you're asked to confirm a `.decisions`/`.patterns`/prose-doc PR actually satisfies the issue it claims to close. This is the doc-class verification stage of the issue-intake pipeline: it consumes the doc PRs `write-code` opens and verifies them one criterion at a time, evidence-based from reading the diff (no test-running). Emits a namespaced, SHA-bound `review-doc: PASS @ <sha> — merge-ready` / `review-doc: FAIL @ <sha> — changes-requested` comment marker (never a native review — ADR 0058), upserted to one-per-PR; for BLOCKING-set doc PRs (touching `.claude/`/`.github`) it is advisory only; it never merges; it never emits a `review-code` marker.
---

# review-doc

You are the **doc-class gate**. `write-code` already picked a triaged issue, implemented
it on a branch, and opened a PR with `Fixes #N` linking the issue — but where
`review-code`'s PR is product code, **yours is a knowledge artifact**: an ADR under
`.decisions/**`, a pattern under `.patterns/**`, or prose `*.md` outside `.claude/` and
`.github/`. Your job is to verify that PR against the **linked issue's
acceptance-criteria checklist** — one criterion at a time — **plus a doc-hygiene
checklist** the doc surfaces demand, and land a clear pass-or-fail verdict on the PR.

You come to this **fresh**, with no sunk-cost attachment to the prose. That detachment is
the whole point: the agent that wrote the doc is the worst judge of whether it lands,
because it knows what it *meant* to say. You only know what the issue *asked for* (the
acceptance criteria) and what the PR *actually writes* (the diff). Verify the second
against the first, from the outside — the same fresh-eyes QA discipline as `review-code`,
aimed at a different artifact class.

You are the doc-artifact twin in the suite: `report` → `triage` → `plan-epic` →
`review-plan` → `write-code` → **`review-code` / `review-doc`** → `ship-it`. `review-code`
gates code PRs; you gate doc PRs; the two split on artifact class and `ship-it` routes to
whichever produced the matching verdict.

## The control-plane boundary decides whether you bind or merely advise

Read ADR [0053](../../../.decisions/0053-control-plane-boundary.md) — it is the binding
spec for this split, and it **supersedes** ADR
[0049](../../../.decisions/0049-pipeline-ships-code-not-itself.md). Two classes of artifact:

- **NON-BLOCKING (autonomous).** Two kinds of artifact, both non-blocking but verified by
  *different* gates:
  - **The doc/knowledge artifacts this gate verifies** — `.decisions/**`, `.patterns/**`,
    and prose `*.md` *outside* `.claude/` and `.github/`. For a doc PR in this set, your
    PASS marker is a **real `ship-it` go-ahead** — `ship-it` merges on it exactly as it
    merges on `review-code`'s.
  - **Product code** — `apps/web/**`, `packages/**`. Non-blocking too, but that's
    `review-code`'s class, **not yours**: a `review-doc` PASS never verifies product code.
    A PR that touches both needs *both* gates (see the mixed code+doc routing in Step 0).

  Both are product or knowledge artifacts; gated for quality, but a human at the merge
  adds no security value.
- **BLOCKING (manual merge).** Anything touching `.claude/**` or `.github/**` — the agent
  control plane (instructions, tools, hooks) and CI enforcement. A bad merge here is a
  serious security concern (self-modification of guardrails; CI/secret exfiltration), so
  a **human merges these by hand** and `ship-it` refuses them. For a doc PR that touches
  this set, you are **advisory only**: review it, post your findings, but say plainly that
  your verdict does **not** authorize a merge — a maintainer does.

So before you verify anything, classify the diff (Step 0). The classification decides
whether your marker binds `ship-it` or is merely advice.

## Authority limit: you never merge

**You do not merge. Not on a pass, not ever, not on your own authority.** Your output is
a *verdict* — a merge-ready signal (non-blocking) or advice (blocking) plus a fail
comment listing what's missing. Merging is the deliberate act of **`ship-it`** (the one
stage granted merge authority) — or, for the blocking set, a human. You signal
merge-ready; `ship-it` is the consumer that asserts your PASS, confirms CI is green, and
squash-merges. Conflating "verified" with "merged" is the self-grading collapse this
stage exists to prevent — the same invariant `review-code` holds.

## You emit a `review-doc` marker, NEVER a `review-code` one

`ship-it` matches the two markers in **separate namespaces** (two anchored,
**emphasis-tolerant**, **SHA-capturing** regexes — the leading `\**` absorbs an optional
bolding `**`, the trailing `@\s*([0-9a-f]{7,40})` captures the bound head SHA —
`^\s*\**\s*review-code:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})` and
`^\s*\**\s*review-doc:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`; see the matcher contract in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §5/§6), latest-verdict-wins
per namespace by timestamp, then a SHA-staleness refusal (ADR 0058). Your verdict's first
line is **always** `review-doc: … @ <sha>` — never `review-code: …`. Emitting a `review-code`
marker on a doc PR would let a code-namespace scan match your verdict (and vice versa),
collapsing the two gates into one. Keep the namespace clean: `review-doc:` for docs, full
stop.

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue and
PR queries. Every issue/PR/review/comment read and write goes through `gh api` REST. This
is not a style preference — GraphQL calls error out on this org.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api`
call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared
contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## The formats contract

Your gate is **format 2, the sub-issue body's `### Acceptance criteria` checklist** — and
**format 6, the review-doc verdict marker** (your namespace). Read the contract so you know
the shapes you verify against and emit:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §2 and §6. §6 defines the
`review-doc` namespace (SHA-bound `PASS @ <sha> — merge-ready` / `FAIL @ <sha> — changes-requested`)
and the advisory blocking-set line, in a namespace distinct from §5's `review-code` marker —
emit only the §6 shapes, never a §5 `review-code` marker.

The key invariant: **every issue carries at least one acceptance criterion.** That's the
floor that guarantees there is always something to verify. If an issue you're handed has
*zero* criteria, the issue is malformed, not the PR — flag that as a process gap (it
should have been caught at `plan-epic`/`report` time) rather than rubber-stamping. Read
the checklist tolerantly: recognize criteria by their checkbox-bullet shape under an
"Acceptance criteria" heading, not by exact punctuation.

You also *read* the progress comments (format 3) and the PR description — `write-code`
leaves a trail there. That trail is context, **not** evidence: a criterion or a hygiene
check is satisfied by what the diff actually shows, not by the author asserting it.

---

## Step 0 — Classify the diff: blocking or non-blocking

Pull the file list first; the classification gates everything after it.

```bash
PR=<pr number>
gh api "repos/$REPO/pulls/$PR/files?per_page=100" \
  --jq '.[] | "\(.status)\t\(.filename)"'
```

- **Any path under `.claude/**` or `.github/**`** → the PR is in the **blocking set**.
  You review it and post your findings, but **advisory only** — your verdict does not
  authorize a merge; a maintainer merges it by hand (ADR 0053). Say so explicitly in the
  verdict (Step 5).
- **Otherwise** (only `.decisions/**`, `.patterns/**`, prose `*.md`, and/or
  `apps/web/**`, `packages/**`) → **non-blocking**. Your PASS marker binds `ship-it`.

If the diff is **pure product code** with no doc/knowledge file at all, this is the wrong
gate — that's `review-code`'s PR. Report `not a doc PR — route to review-code` (a plain note,
**not** a `review-doc:` marker — there's no doc to verdict) and stop.
If the diff is **mixed code + doc** (both a `*.md` knowledge file and `apps/web`/`packages`
code, none of it blocking), it needs *both* gates: you verify the doc class here and emit
the `review-doc` marker; `review-code` verifies the code class and emits its own. `ship-it`
requires the latest PASS in **each** namespace present before it merges, so don't try to
cover the code half — verify the docs, emit `review-doc`, and note that `review-code` must
also pass.

---

## Step 1 — Resolve the PR and its linked issue

```bash
gh api repos/$REPO/pulls/$PR \
  --jq '{number, state, draft, merged, head: .head.ref, base: .base.ref, body}'
```

Find the linked issue from the PR body's `Fixes #N` / `Closes #N` (the seam `write-code`
writes). Cross-check via the timeline if it's not obvious:

```bash
gh api "repos/$REPO/issues/$PR/timeline?per_page=100" \
  --jq '.[] | select(.event=="connected" or .event=="cross-referenced") | .source.issue.number // .issue.number' 2>/dev/null
```

The `issues/$PR/timeline` endpoint accepts the PR number, and the
`connected`/`cross-referenced` events resolve PR→issue — so `.source.issue.number` is the
linked *issue*, not a bug. This is the same idiom `review-code` uses. Pin down `ISSUE=<N>`.
If you genuinely can't find a linked issue, that's a fail you can't even start — comment on
the PR that there's no linked issue to verify against (the `Fixes #N` seam is missing), and
stop.

Now pull the issue and its acceptance criteria:

```bash
ISSUE=<N>
gh api repos/$REPO/issues/$ISSUE --jq '{number, state, assignee: .assignee.login, body}'
gh api "repos/$REPO/issues/$ISSUE/comments?per_page=100" --jq '.[].body'
```

Extract the `### Acceptance criteria` checklist from the issue body. That list — every
box — is half the contract you verify; the doc-hygiene checklist (Step 3) is the other.

---

## Step 2 — Read what the PR actually writes

Verification is grounded in the **diff**, not the PR's self-description. There is **no
test-running here** — a doc PR has no behavior to exercise; the artifact *is* the prose,
so you read it. Pull the change:

```bash
gh pr diff $PR \
  || gh api repos/$REPO/pulls/$PR -H "Accept: application/vnd.github.v3.diff"
```

For checks that need the file in context (a link target exists, an index row matches, a
supersession cross-link resolves), read the file at the PR head rather than inferring from
the hunk alone:

```bash
git fetch origin && git checkout <pr head ref>   # or: gh pr checkout $PR for a cross-fork PR
```

You're reading, not building — no `pnpm install`, no typecheck, no test suite. The diff
and the files it touches are your whole evidence base.

---

## Step 3 — Verify the acceptance criteria one box at a time

Walk the issue's checklist **one box at a time**. For each criterion, reach an
independent verdict and capture the *evidence* from the diff that supports it. This
per-criterion discipline is the heart of the gate — a blanket "reads fine" is exactly the
rubber-stamp the fresh QA pass exists to prevent.

For each criterion, decide one of:

- **PASS** — the diff demonstrably satisfies it. Evidence is concrete: the file + lines
  that implement it (a heading added, a row inserted, a path written).
- **FAIL** — it's not satisfied, or only partially. Evidence is what's missing or wrong:
  the criterion asked for X, the PR writes Y (or nothing).
- **UNVERIFIABLE** — you cannot determine it from the diff (the criterion is too vague to
  check, or depends on something not in the PR). Treat as a soft fail: say *why*, and what
  the PR would need to make it checkable. Don't pass something you couldn't confirm.

**The acceptance-criteria verdict is conjunctive: every box must PASS.** One FAIL or
UNVERIFIABLE → the PR fails the gate.

---

## Step 4 — Run the doc-hygiene checklist (always, regardless of AC)

The acceptance criteria say whether the PR did *the issue's* job; the hygiene checklist
says whether the doc is *well-formed for its surface* — the doc-class equivalent of
`review-code`'s typecheck/lint, run **on every doc PR regardless of what the AC say**. A
doc can satisfy its issue and still leak a home path or break an index row. Each check is
PASS / FAIL with diff evidence, and **a hygiene FAIL fails the gate** the same as an AC
FAIL — the overall verdict is conjunctive across *both* lists.

Run each, scoped to the files the PR touches:

1. **House-format.** The doc fits its surface's shape.
   - An **ADR** (`.decisions/NNNN-*.md`) has the frontmatter (`id`, `title`, `status`,
     `date`, `tags`) and the **`## Context` / `## Decision` / `## Consequences`** sections
     — the house ADR shape every existing ADR follows. Mirror an existing file (e.g.
     [`0049`](../../../.decisions/0049-pipeline-ships-code-not-itself.md)) if unsure.
   - A **pattern** (`.patterns/*.md`) reads as how-the-code-is-shaped, not a why-essay
     (the why belongs in `.decisions/`).
   - **Prose** (README and friends) states current-state-for-builders, not retired
     context (CLAUDE.md "Doc surfaces").
2. **Index row exists + status matches.** A new/changed **ADR** has a matching row in
   [`.decisions/index.md`](../../../.decisions/index.md), and the row's **Status column
   matches the file's frontmatter `status`** (a file marked `accepted` whose index row
   still says `proposed` is a FAIL). A new **pattern** has its row in
   [`.patterns/index.md`](../../../.patterns/index.md). Verify the row is in the diff (or
   already present and consistent), not merely assumed.
3. **Links resolve.** Every relative link the diff adds points at a path that **exists**
   (check the target file is in the repo at the PR head). A dead in-repo link is a FAIL.
   In-repo links must be standard markdown relative paths, not Obsidian `[[wikilinks]]`
   (CLAUDE.md conventions).
4. **No leaked local/home paths — the #158 class.** The diff introduces **no** absolute
   home/local/vault path: grep the added lines for `/Users/`, a leading `~/`, `~/.claude`,
   `~/.agent`, or vault-style sibling-repo paths. Repo-relative paths only. This is a hard
   FAIL — a leaked path in a committed doc is the exact regression class #158 exists to
   stop.

   ```bash
   # added lines only ('+'), scanned for home/local/vault path leaks
   gh pr diff $PR | grep -E '^\+' | grep -nE '/Users/|[^A-Za-z0-9]~/|~/\.(claude|agent)|/vault/'
   ```

   A hit is a FAIL **unless it is one of the deliberate-non-leak cases — judge each in
   context**: a fenced *example* of what-not-to-do, or — for a doc whose subject *is* path
   hygiene (a path-hygiene check, skill, convention doc, or the check's own pattern/prose;
   **this very SKILL.md is the canonical false positive** — it spells out `/Users/`,
   `~/.claude`, `~/.agent`, `/vault/` as the *pattern*, not as real paths) — a token that
   is **documented as the leak pattern** rather than **committed as a real path**. The
   discriminator is exactly that: committed-as-a-real-path → FAIL; documented-as-a-pattern
   → expected, pass. For an ordinary doc the default is still fail. Note that a path PR is
   often in the blocking set anyway (this file touches `.claude/`, so your verdict here is
   advisory — Step 0), but a sibling path-hygiene doc *outside* `.claude/`/`.github/` is
   non-blocking and would hit this carve-out for real. The line number `grep -n` prints is
   the position in the filtered stream, not the file line — locate the real `file:line`
   from the diff hunk the hit sits in.
5. **Supersession noted + cross-linked.** If this doc replaces or amends a prior decision,
   the **superseding** doc names what it supersedes *and* the **superseded** doc is updated
   to point forward (its frontmatter/status and its index row reflect
   `superseded by [NNNN]`). A new ADR that obsoletes an old one without touching the old
   one's status is a FAIL — the cross-link must close both ways (see how
   [`0049`](../../../.decisions/0049-pipeline-ships-code-not-itself.md) and the index
   handle the chain).
6. **Status sanity.** The `status` is a real value in the house vocabulary (`proposed`,
   `accepted`, `superseded`/`superseded by …`, `amended-in-part by …`, `retired`,
   `reference`) and is *coherent* with the content — e.g. an ADR that announces a settled
   boundary the suite already depends on should not be left `proposed` without reason.

Build the hygiene findings into the same evidence shape as the AC table:

```
- [PASS] House-format — ADR has Context/Decision/Consequences (.decisions/0053-*.md)
- [FAIL] Index row — file is `accepted` but .decisions/index.md row reads `proposed`
- [PASS] No leaked paths — grep of added lines clean
```

---

## Step 5 — Land the verdict

The overall verdict is **conjunctive across both lists**: every acceptance criterion AND
every hygiene check must PASS. One miss anywhere → FAIL.

**Resolve the head SHA you reviewed** and write the verdict to a per-run temp file
(`VERDICT_FILE="$(mktemp /tmp/review-doc-verdict.XXXXXX)"`) so multi-line markdown + backticks
survive the shell, then post it. Allocate it with `mktemp`, not a fixed
`/tmp/review-doc-verdict-${PR}.md`: the PR number alone isn't unique — two reviews of the *same*
PR running concurrently would collide on it, one run's unread verdict stalling the write or
leaking into the other. The SHA goes into the marker's first line
(`review-doc: PASS @ <sha> — merge-ready`) and is **load-bearing**: `ship-it` refuses any
verdict not bound to the PR's current head (ADR
[0058](../../.decisions/0058-sha-bound-verdict-contract.md), issue #258).

```bash
HEAD_SHA="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"   # the head you reviewed
```

### Pass path — non-blocking PR (the binding signal)

Every criterion and every hygiene check passed, and Step 0 classified the PR
**non-blocking**. Land the namespaced, SHA-bound marker so `ship-it` can merge on it.

`review-doc` lands its verdict **only as the SHA-bound comment, never a native `APPROVE`**
(ADR 0058 rule 4): a native review can't carry the `@ <sha>` in the shape this contract
controls, so emitting one would leave `ship-it` comparing a review against a comment for the
doc lane — two incomparable records. The comment is the single carrier, resolving the
APPROVE-vs-comment duality #258 flagged.

The post is an **upsert**, not an append: scan the PR for *your own* prior `review-doc:`
marker comment and `PATCH` it with the fresh verdict instead of `POST`-ing a new one, so
there is exactly **one** `review-doc` verdict comment per PR (ADR 0058 rule 2). A re-review of
a new head overwrites the same record with the new `@ <sha>`. The `… | last | .id` upsert
PATCHes only your *newest* own marker, so on a PR migrated from the pre-0058 append era a few
older SHA-less own markers may linger — the one-per-gate invariant is **forward-looking**, and
those legacy duplicates are tolerated because `ship-it`'s consumer SHA-refuses any marker
without an `@ <sha>` on the current head (Step 2b), so they can never authorize a merge.

```bash
VERDICT_FILE="$(mktemp /tmp/review-doc-verdict.XXXXXX)"
# write your composed PASS verdict into "$VERDICT_FILE" (first line: review-doc: PASS @ <HEAD_SHA> — merge-ready)
BODY="$(cat "$VERDICT_FILE")"
ME="$(gh api user --jq .login)"
# --arg is a jq flag, not a gh-api one (ADR 0055), so pipe the fetched comments to standalone jq:
comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")
MINE=$(jq -r --arg me "$ME" 'map(select(.user.login==$me
          and (.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))))
        | last | .id // empty' <<<"$comments")
if [ -n "$MINE" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$MINE" -f body="$BODY"   # upsert
else
  gh api -X POST  "repos/$REPO/issues/$PR/comments"   -f body="$BODY"   # first verdict
fi
```

Verdict body shape. The first line is the **canonical bare marker** — no leading `**`
emphasis, **with the `@ <HEAD_SHA>` you resolved above** — per the matcher contract in
[gh-issue-intake-formats.md](../gh-issue-intake-formats.md) §5/§6 (matchers tolerate an
optional leading `**`, but emit bare; the `@ <sha>` is required, ADR 0058):

```markdown
review-doc: PASS @ <HEAD_SHA> — merge-ready

Verified PR #<PR> against the acceptance criteria of #<ISSUE> + the doc-hygiene checklist:

**Acceptance criteria**
- [PASS] <criterion 1> — <evidence: file:lines>
- [PASS] <criterion 2> — <evidence>

**Doc hygiene**
- [PASS] House-format — <evidence>
- [PASS] Index row + status match — <evidence>
- [PASS] Links resolve — <evidence>
- [PASS] No leaked local/home paths — <evidence>
- [PASS] Supersession noted + cross-linked — <evidence / n/a>
- [PASS] Status sanity — <evidence>

All checks pass. This PR is merge-ready. **review-doc does not merge** — `ship-it` is the
authorized merge step; merging will auto-close #<ISSUE> via `Fixes #<ISSUE>`.
```

### Pass path — blocking-set PR (advisory only)

Every check passed but Step 0 classified the PR **blocking** (it touches `.claude/**` or
`.github/**`). Post the **same evidence**, but the first line is **not** a merge-ready
go-ahead — it is advice. `ship-it` refuses this PR regardless; a human merges it.

```markdown
review-doc: advisory — blocking-set PR (manual merge)

PR #<PR> touches `.claude/`/`.github/` — the agent control plane (ADR 0053). My verdict is
**advisory only**: it does **not** authorize a merge. A maintainer merges this by hand.

Verified against #<ISSUE>'s acceptance criteria + doc hygiene — all checks pass:

**Acceptance criteria**
- [PASS] <criterion 1> — <evidence: file:lines>
- [PASS] <criterion 2> — <evidence>

**Doc hygiene**
- [PASS] House-format — <evidence>
- [PASS] Index row + status match — <evidence>
- [PASS] Links resolve — <evidence>
- [PASS] No leaked local/home paths — <evidence>
- [PASS] Supersession noted + cross-linked — <evidence / n/a>
- [PASS] Status sanity — <evidence>
```

Post the advisory line **as a comment, not a native `REQUEST_CHANGES`/review** — the
blocking-set path is comment-only too, exactly like the PASS and FAIL paths (ADR 0058
rule 4). Upsert it the same way (`PATCH` your own prior `review-doc:` marker if one exists,
else `POST`):

```bash
VERDICT_FILE="/tmp/review-doc-verdict-${PR}.md"
BODY="$(cat "$VERDICT_FILE")"   # first line: review-doc: advisory — blocking-set PR (manual merge)
ME="$(gh api user --jq .login)"
# --arg is a jq flag, not a gh-api one (ADR 0055), so pipe the fetched comments to standalone jq:
comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")
MINE=$(jq -r --arg me "$ME" 'map(select(.user.login==$me
          and (.body | test("^\\s*\\**\\s*review-doc:"; "i"))))
        | last | .id // empty' <<<"$comments")
if [ -n "$MINE" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$MINE" -f body="$BODY"
else
  gh api -X POST  "repos/$REPO/issues/$PR/comments"   -f body="$BODY"
fi
```

Do **not** emit the `review-doc: PASS @ <sha> — merge-ready` marker for a blocking PR — that marker is a
`ship-it` go-ahead, and `ship-it` must refuse the blocking set. The advisory line keeps
your verdict out of `ship-it`'s PASS namespace while still recording the advisory verdict
(as a comment, per ADR 0058 rule 4) — the advisory line carries no `@ <sha>` because no
`ship-it` namespace consumes it; a human merges these (ADR 0053).

### Fail path — any miss (non-blocking or blocking)

One or more checks failed (or were unverifiable). **Nothing merges. The PR stays open;
the issue stays open and assigned to whoever claimed it** — don't unassign, relabel, or
close. Post a comment whose first line is the namespaced, SHA-bound FAIL marker (the seam
`write-code`'s fix round-trip keys on), with the full per-check table — the passing rows
too, so the author sees how close they are. **Upsert** it (`PATCH` your own prior
`review-doc:` marker if one exists, else `POST`) exactly as the PASS path — one `review-doc`
verdict comment per PR (ADR 0058 rule 2):

```bash
HEAD_SHA="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"   # the head you reviewed
VERDICT_FILE="$(mktemp /tmp/review-doc-verdict.XXXXXX)"
# write your composed FAIL verdict into "$VERDICT_FILE" (first line: review-doc: FAIL @ <HEAD_SHA> — changes-requested)
BODY="$(cat "$VERDICT_FILE")"
ME="$(gh api user --jq .login)"
# --arg is a jq flag, not a gh-api one (ADR 0055), so pipe the fetched comments to standalone jq:
comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")
MINE=$(jq -r --arg me "$ME" 'map(select(.user.login==$me
          and (.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))))
        | last | .id // empty' <<<"$comments")
if [ -n "$MINE" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$MINE" -f body="$BODY"
else
  gh api -X POST  "repos/$REPO/issues/$PR/comments"   -f body="$BODY"
fi
```

Verdict body shape:

```markdown
review-doc: FAIL @ <HEAD_SHA> — changes-requested

Verified PR #<PR> against #<ISSUE>'s acceptance criteria + the doc-hygiene checklist:

**Acceptance criteria**
- [PASS] <criterion 1> — <evidence>
- [FAIL] <criterion 2> — asked <X>, but the diff <writes Y / nothing>; <pointer>

**Doc hygiene**
- [PASS] House-format — <evidence>
- [FAIL] No leaked local/home paths — `<the leaked /Users/… or ~/… line>` at <file:line>
- [UNVERIFIABLE] <check> — <why; what'd make it checkable>

Failing items above must be addressed before this PR can merge. The PR stays open and
unmerged; #<ISSUE> stays open and assigned. Re-request review once they're satisfied.
```

Do **not** post a native `REQUEST_CHANGES` review — `review-doc` is comment-only (ADR 0058
rule 4), so the SHA-bound marker comment is the **sole** verdict artifact. Recognize the
marker tolerantly by shape (`review-doc: FAIL @ <sha>`), not exact dashes. Do **not** touch the issue's
labels, assignee, or state on a fail — a failed gate is a no-op on the work state plus a
comment.

---

## Running it

A single invocation gates one doc PR end to end: classify blocking vs non-blocking
(Step 0), resolve the PR ↔ issue (Step 1), read the diff (Step 2), verify each acceptance
criterion (Step 3) and run the doc-hygiene checklist (Step 4), then land the verdict —
namespaced `review-doc: PASS` (non-blocking) or advisory (blocking) on a full pass, or
`review-doc: FAIL` on any miss (Step 5). **You never merge, and you never emit a
`review-code` marker.**

Report back a short ledger: the PR and its linked issue, its class (blocking/non-blocking),
the per-item verdict (N pass / M fail across AC + hygiene), the overall result, and the
link to the review/comment you posted. Don't narrate every REST call — the posted verdict
is the durable record.

The gate is **stateless**: a re-review re-reads the (possibly updated) criteria and
re-runs every check against the current diff, so it naturally picks up both the fixes and
any criteria that changed underneath — exactly the property `ship-it`'s latest-verdict-wins
relies on.

## Conventions

This skill is one of a suite (`report` → `triage` → `plan-epic` → `review-plan` →
`write-code` → **`review-code` / `review-doc`** → `ship-it`) that turns GitHub issues into
an agent-operable pipeline. The shared label semantics and the body/comment/dependency/
marker formats live in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md);
the control-plane boundary that decides whether your marker binds `ship-it` or merely
advises is ADR [0053](../../../.decisions/0053-control-plane-boundary.md) (which supersedes
[0049](../../../.decisions/0049-pipeline-ships-code-not-itself.md)). Your input is a
`write-code`-produced PR whose diff is a knowledge artifact, linked by `Fixes #N`; your
output is the verdict that decides whether that doc PR is merge-ready (non-blocking) or
records advice for the human merger (blocking). You are the doc-artifact twin of
[`review-code`](../review-code/SKILL.md): the two gates split on artifact class — code →
`review-code`, docs → you — and neither merges on its own authority (`ship-it` does that)
nor strays into the other's namespace.
