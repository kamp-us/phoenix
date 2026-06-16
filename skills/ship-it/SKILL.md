---
name: ship-it
description: Ship one verified PR on the configured target repo — the authorized merge step the rest of the pipeline defers to. Given a PR number, assert the matching gate has signalled PASS (review-code for code, review-doc for docs, review-skill for skills), confirm CI is already green, squash-merge, and confirm the linked issue auto-closed — and REFUSES to self-merge control-plane PRs (.claude/.github + the gate-critical skills), which a human merges by hand (ADR 0053). Trigger on "ship #N", "ship it", "it's merge-ready, ship it", "close the loop on #N", "merge #N", "/ship-it". This is the terminal stage of the issue-intake pipeline: it consumes the merge-ready signal the gates produce and is the ONLY skill granted merge authority.
---

# ship-it

You are the merge actor — the one stage authorized to merge a PR and close the loop.
A gate (`review-code` for product code, `review-doc` for docs, `review-skill` for skills)
verified the PR against its issue's acceptance criteria (code/skills) or doc-quality bar
(docs) and signalled **merge-ready**, then stopped, because conflating
"verified" with "merged" is the self-grading collapse the gate exists to prevent. You are the
separate, deliberate act it defers to. See ADR [0048](https://github.com/kamp-us/phoenix/blob/main/.decisions/0048-ship-it-merge-actor.md)
for the why — note that gate is now one of three (`review-code`/`review-doc`/`review-skill`)
under ADRs [0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md) and
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md), so 0048's prose, which
predates the split, only discusses `review-code`.

You ship **exactly one PR** per invocation. You do not sweep all open PRs — that fan-out
belongs to whatever loop drives the pipeline; keeping this stage atomic keeps it
composable and idempotent (re-running it on an already-merged PR is a clean no-op).

## The control-plane boundary — what you may auto-merge

A PR is in one of two classes by the files it touches (ADR
[0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md), which supersedes
[0049](https://github.com/kamp-us/phoenix/blob/main/.decisions/0049-pipeline-ships-code-not-itself.md)):

- **BLOCKING — never auto-merged.** Any PR touching `.claude/**`, `.github/**`, or one of the
  **gate-critical skills** is the agent control plane: agent instructions/tools/hooks
  (`.claude`), CI enforcement (`.github`), and the verification/merge machinery + marker
  contract (the gate-critical skills). A bad merge here is a serious security concern —
  self-modification of the guardrails, or CI/secret exfiltration. A human merges these by
  hand; the pipeline NEVER self-merges them. If the diff touches even one such file, you
  **refuse** (see Step 0).

  The **gate-critical skills** are `skills/ship-it/**`, `skills/review-code/**`,
  `skills/review-doc/**`, `skills/review-skill/**`, `skills/review-plan/**`, and
  `skills/gh-issue-intake-formats.md` — the verification/merge gates plus the shared
  marker-namespace/regex contract they all depend on. The single canonical definition of this
  set lives in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §CP; cite it,
  don't re-hard-code the path list (the three independent copies are exactly the #375 drift
  class §CP closes — ADR 0073 §6). They are control plane **regardless of directory**, because
  the one catastrophic case the AC-gates can't catch is a *gate auto-merging a weakening of
  itself*; ADR
  [0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md)
  makes exactly this subset blocking. This is a merge-authority concern only and is
  **independent of routing**: every gate-critical skill is still verified — now by
  `review-skill` (ADR [0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md),
  superseding 0063's `review-code` routing) — and the human reads that verdict, then merges by
  hand. **Every OTHER `skills/**`** (triage, plan-epic, write-code, heal-ci, report, …) stays
  **non-blocking** — `review-skill`-routed and auto-merged on a PASS, because those skills
  neither merge nor verify, so a bad edit still has to clear the gate that does. ADR 0065's
  blocking rule is **unchanged** by 0073: `review-skill` is the *verdict* gate; merge-authority
  (blocking) is the *separate* axis 0065 owns, and 0065 stands verbatim until a later decision
  retires it against `review-skill`'s evidence (ADR 0073 §4).
- **NON-BLOCKING — autonomous.** Everything else — `apps/web/**`, `packages/**`,
  `.decisions/**`, `.patterns/**`, and other prose docs. These are product or knowledge
  artifacts; they are gated for quality, but a human at the merge adds no security value, so
  you ship them once the matching gate PASSes.

Note `.decisions/**` and `.patterns/**` are **non-blocking** under 0053 — they auto-merge
through `review-doc` (the boundary moved off "harness vs not" to "control plane vs not").

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
and PR queries. Every read and write goes through `gh api` REST or the `gh pr`/`gh run`
porcelain. This is not a style preference — GraphQL calls error out on this org.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api`
call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared
contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## The hard guards

These are the rules that make shipping safe; violate any one and the gate above you was
pointless.

1. **Merge only on a PASS that is the current verdict.** You merge on the *latest* verdict
   being a PASS, never on the mere *presence* of a historical PASS nor the *absence* of a
   failure — a newer FAIL vetoes an older PASS (Step 2 resolves latest-wins per gate
   namespace). No PASS marker and no approving review → you stop and report the PR as
   unverified. A red or pending check is not a "fail you can override" — it is a "not yet."
2. **Merge only on a commit-bound run-evidence bundle whose every check passed.** Beyond the
   marker, the run-evidence bundle (Step 3.5) is the SHA-bound proof behind the green: a
   missing bundle, an unreadable schema, a `commit` that isn't the head SHA (stale), or any
   `checks[]` entry that isn't `pass` → you refuse. This is **additive** to the PASS-marker
   and CI-green reads, not a replacement (ADR 0054 §3 / 0056).
3. **You are the only skill that merges.** If you find yourself wanting to merge a PR a gate
   hasn't passed, the answer is to route it back through that gate (`review-code` /
   `review-doc`), not to merge it here.

## The merge-ready signals

The pipeline runs **three gates**, one per artifact class, each landing its verdict as a
first-line marker comment:

Every verdict is **SHA-bound** — its first line carries the head it reviewed (`@ <sha>`), and
you refuse any verdict not bound to the PR's *current* head (Step 2b, ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)):

- **product code** (`apps/web`, `packages`, other code) → `review-code`, whose marker is
  `review-code: PASS @ <sha> — merge-ready` or `review-code: FAIL @ <sha> — not merge-ready`
  (canonical shape: [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §5).
  `review-code` can also land a native **approving review** (`event=APPROVE`), whose
  `commit_id` is its bound SHA.
- **docs** (`.decisions`, `.patterns`, prose `*.md` outside `.claude`/`.github` and outside
  `skills/**`) → `review-doc`, whose marker is `review-doc: PASS @ <sha> — merge-ready` or
  `review-doc: FAIL @ <sha> — changes-requested` (canonical shape: §6). `review-doc` is
  **comment-only** — it never lands a native review (ADR 0058), so the doc lane is a single
  comparable record type, not a review-vs-comment mix.
- **skills** (`skills/**`) → `review-skill`, whose marker is
  `review-skill: PASS @ <sha> — merge-ready` or `review-skill: FAIL @ <sha> — changes-requested`
  (canonical shape: §6.5). `review-skill` is **comment-only** like `review-doc` (ADR 0058). This
  **supersedes ADR 0063's** `skills/**` → `review-code` routing (ADR 0073 §4): a skill is a
  behavioral artifact, gated by the gate built for it.

The marker-comment path is the **default** to expect: the single operator on this repo
(`usirin`) cannot post an approving review on their own PR under org branch rules, so on
the common path the gate falls back to a marker comment. **You are the consumer the markers
were written for** — without you, they are inert verdicts nobody acts on. Recognize a marker
tolerantly by shape (`review-code: PASS @ <sha>` … `merge-ready`, `review-code: FAIL @ <sha>`
… `not merge-ready`, `review-doc: PASS @ <sha>` … `merge-ready`, `review-doc: FAIL @ <sha>` …
`changes-requested`, `review-skill: PASS @ <sha>` … `merge-ready`, `review-skill: FAIL @ <sha>`
… `changes-requested`), not by exact dashes — but the `@ <sha>` is required, and a SHA-less
legacy marker resolves to `unverified`, not PASS.

Each gate is **stateless and re-runs**, so a PR can flip PASS → (new commits) → FAIL or
FAIL → PASS, and (for code) the marker and the native-review forms interleave. So you never
act on the *presence* of a PASS; you act only on the **latest** verdict per gate. A FAIL
marker (or a `CHANGES_REQUESTED` review) that is the latest verdict for an artifact class
present in the diff is the mirror signal: the PR has unaddressed failures → you do not ship
it. The fix round-trip is `write-code`'s (code) / the doc author's job, not yours.

---

## Step 0 — Classify the diff against the control-plane boundary (guard 0)

Before anything else, read the PR's changed files and split them by class. This is one read:

```bash
PR=<pr number>
gh api "repos/$REPO/pulls/$PR/files?per_page=300" --jq '[.[].filename]'
```

Classify each path. The **control-plane / blocking set** is defined **once** in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §CP — cite that regex, don't
re-hard-code the path list (the three independent copies are the #375 drift class §CP closes,
ADR 0073 §6):

- **control plane (blocking):** matches the §CP set — `.claude/**`, `.github/**`, or a
  **gate-critical skill** (`skills/ship-it/**`, `skills/review-code/**`,
  `skills/review-doc/**`, `skills/review-skill/**`, `skills/review-plan/**`,
  `skills/gh-issue-intake-formats.md`). A gate-critical skill is blocking **for merge
  authority** (ship-it refuses → manual human merge, ADR
  [0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md),
  **unchanged** by 0073) AND is **routed to `review-skill`** for its verdict (ADR
  [0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md), superseding 0063's
  `review-code` routing) — the two axes are independent. The blocking refusal short-circuits in
  the **Routing** step below, *before* the namespace check, so the `review-skill` routing stays
  correct for the human-read verdict: gate-critical skills are **skill-class for ROUTING,
  blocking for MERGE**. Every OTHER `skills/**` is **non-blocking** — skill-class for routing
  and auto-merged on a `review-skill` PASS.
- **skills:** under `skills/**` (the `^skills/` probe) → **skill-class**, requiring a
  `review-skill` PASS. A skill is a behavioral artifact, gated by `review-skill`, not the code
  AC-gate nor the doc hygiene-gate (ADR 0073 §4, superseding ADR
  [0063](https://github.com/kamp-us/phoenix/blob/main/.decisions/0063-skills-are-code-gated.md)).
- **code:** under `apps/web/**` or `packages/**` (the `^(apps/web|packages)/` probe); a source
  path matching none of the three probes still defaults to code, requiring a `review-code`
  PASS, so nothing under-gates.
- **docs:** `.decisions/**`, `.patterns/**`, or a prose `*.md` *outside* `.claude`/`.github`
  **and outside `skills/**`** (`skills/**` is the skill class, carved out of docs first).

```bash
FILES=$(gh api "repos/$REPO/pulls/$PR/files?per_page=300" --jq '.[].filename')
CONTROL_PLANE_RE='^(\.claude|\.github)/|^skills/(ship-it|review-code|review-doc|review-skill|review-plan)/|^skills/gh-issue-intake-formats\.md$'   # the §CP canonical set — one definition (ADR 0073 §6)
echo "$FILES" | grep -Eq "$CONTROL_PLANE_RE" && echo "BLOCKING"   # control plane: .claude/.github + the gate-critical skills (ADR 0065); other skills/** auto-merge on a review-skill PASS (ADR 0073)
echo "$FILES" | grep -Eq '^skills/' && echo "has-skills"   # skill-class probe → review-skill (ADR 0073, supersedes 0063)
echo "$FILES" | grep -Eq '^(apps/web|packages)/' && echo "has-code"   # code probe (skills/** is its OWN class now — ADR 0073)
# docs probe EXCLUDES skills/** first, so a skills-only .md PR is NOT classed docs
echo "$FILES" | grep -Ev '^skills/' | grep -Eq '^(\.decisions|\.patterns)/|\.md$' && echo "has-docs"
```

**Routing:**

- If **any** file is control plane (the §CP set — `.claude/**`, `.github/**`, or a
  gate-critical skill) → **REFUSE.** Report `blocking — manual merge` and stop. A human merges
  the control plane by hand (ADR 0053; gate-critical skills added by ADR 0065, with
  `review-skill/**` added by ADR 0073); the pipeline never self-merges its own guardrails.
  This holds even if the rest of the diff is clean code/docs/skills — a mixed PR that touches
  the control plane is still a manual merge, and should be split so the non-blocking half can
  flow. This refusal short-circuits **before** the namespace check below, so it never conflicts
  with the fact that a gate-critical `skills/**` PR is still `review-skill`-routed (ADR 0073):
  the routing decides *which gate's verdict the human reads*, this refusal decides *who merges*.
  A `skills/**` PR that touches **no** gate-critical skill is **not** blocking — it flows
  through `review-skill` and auto-merges on a PASS.
- Otherwise, note which **artifact classes are present** (skills, code, docs, or a mix). Step 2
  requires the matching gate's latest verdict = PASS for **each class present**: skills →
  `review-skill` PASS; code → `review-code` PASS; docs → `review-doc` PASS; a mixed PR needs a
  current-head PASS in **each** namespace present. Carry the class set into Step 2.

The `.md$` probe over-matches (it catches code-adjacent markdown too); that's fine — it only
decides *whether to require a review-doc PASS*, and requiring one extra PASS never makes an
unsafe merge. The control-plane check is the only one that must be exact, and it is. The **one
path-class the docs probe must *not* match is `skills/**`**: a skill `.md` is `review-skill`-gated
(ADR 0073), so the `grep -Ev '^skills/'` runs *before* the `.md$` match — otherwise a
`review-skill`-verified skills-only PR would be classed docs and `ship-it` would demand a
`review-doc` PASS that never comes (the #358 deadlock, now closed by the dedicated gate rather
than by code-routing). Excluding `skills/**` here is what keeps a skills-only PR flowing through
exactly the one gate (`review-skill`) that ran it.

---

## Step 1 — Resolve the PR and its linked issue

```bash
gh api repos/$REPO/pulls/$PR \
  --jq '{number, state, draft, merged, mergeable, head: .head.ref, base: .base.ref, body}'
```

If the PR is already `merged` → nothing to do, report it shipped and stop (idempotent).
If it's `draft` or `state=closed` (unmerged) → stop, report why.

Find the linked issue from the PR body's `Fixes #N` / `Closes #N` (the seam `write-code`
writes and `review-code` relies on) and pin it as a shell var Step 5 reads back:

```bash
ISSUE=<N>
```

If there is **no** linked issue, stop and report `no linked issue`. In this pipeline
`write-code` always writes `Fixes #N`, so a missing link is a broken seam, not a normal
state — an unlinked PR has nothing to auto-close on merge and would leave dangling work.
This is distinct from the *linked-but-didn't-auto-close* case Step 5 handles: there the
seam exists but GitHub didn't fire it, which is recoverable; here the seam itself is
absent, which is an anomaly worth stopping on.

---

## Step 2 — Resolve the *latest current-head* verdict per gate namespace, then branch on polarity (guard 1)

You do **not** ship on the presence of any PASS that ever existed. Each gate is stateless and
re-runs, so a PR can go PASS → FAIL or FAIL → PASS. Resolve **`review-code`, `review-doc`, and
`review-skill` in separate namespaces** — three anchored regexes that never cross-match — and
require a latest PASS in **each namespace whose artifact class is present** (from Step 0). A
scan in one namespace must never match another's marker.

The three anchors (case-insensitive, anchored at the start of the comment body so a comment
that merely *quotes* a marker mid-body doesn't match, **emphasis-tolerant** — the leading
`\**` absorbs an optional bolding `**`, since `review-code` emits its marker bolded — and
**SHA-capturing** — the trailing `@\s*([0-9a-f]{7,40})` captures the bound head SHA so Step 2b
can apply the staleness refusal; see the matcher contract in
[gh-issue-intake-formats.md](../gh-issue-intake-formats.md) §5/§6/§6.5 and ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)):

- code:  `^\s*\**\s*review-code:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- doc:   `^\s*\**\s*review-doc:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- skill: `^\s*\**\s*review-skill:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`

A marker matching the looser `…:\s*(PASS|FAIL)` prefix but **not** the `@ <sha>` tail is a
pre-0058 legacy verdict → Step 2b resolves it to `unverified (verdict not bound to current
head)`, never a PASS.

A marker comment counts as a verdict **only if its author holds `write`-or-higher permission
on the repo** — authorization is resolved from GitHub's ACL at merge time, not from a list
in this file, so a forged `review-code: PASS` / `review-doc: PASS` from any commenter without
repo write (the `write-code` agent, a stranger) is invisible to the resolution, treated
exactly as ordinary PR chatter, never a verdict and never a FAIL (ADR
[0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md), superseding 0051). GitHub's
repo-collaborator permission is the single source of truth for *whose* PASS counts — a PR
author cannot widen it via a file in their own diff. The solo operator `usirin` (who can't
`APPROVE` their own PR under org branch rules, so their marker is the load-bearing default —
ADR 0048) holds `admin` and passes; any future operator or review-bot earns standing by being
a `write+` collaborator, with no edit to this skill.

Resolve the authorized-author set from the ACL — every distinct marker author whose repo
permission is `write` / `maintain` / `admin`. This fails closed: a lookup error or a
`read`/`triage` author never enters the set, so their marker is ignored exactly as an
off-list author was under 0051. When *no* author clears the bar, `authorized` stays `[]`
and `IN($authorized[])` below matches nothing — every namespace resolves to `null`, i.e.
`unverified` → refuse — so the empty set is the safe terminal state, not an open door.

```bash
comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")

# distinct logins that posted any review-code/review-doc/review-skill marker
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*(PASS|FAIL)"; "i"))
    | .user.login] | unique | .[]' <<<"$comments")

# keep only those holding write+ on the repo (GitHub's ACL is the trust root, ADR 0055)
authorized='[]'
while IFS= read -r a; do
  [ -z "$a" ] && continue
  perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
  case "$perm" in
    admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;;
  esac
done <<<"$markerAuthors"
```

Read the latest of each form (sorted by timestamp, newest last — don't lean on the API's
return order for a merge decision). The author gate (`IN($authorized[])`) runs *before*
`sort_by | last`, so a forged newer marker from an unauthorized author can't shadow a real
older verdict:

```bash
# the PR's CURRENT head SHA — the head every verdict must be bound to (ADR 0058)
CURRENT_HEAD="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"

# latest decisive native review (APPROVED / CHANGES_REQUESTED) — the review-code path only.
# GitHub author-attributes reviews, so this path is unforgeable and needs no ACL check.
# Carry .commit_id: it IS the SHA the reviewer approved, so Step 2b applies the same staleness
# test to a native review as to a marker's @ <sha>.
gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id, at: .submitted_at}'

# latest review-code marker comment (code namespace) — author-gated, anchored, never matches review-doc.
# Capture the bound head SHA from the @ <sha> tail; a SHA-less legacy marker yields sha=null → Step 2b refuses.
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' <<<"$comments"

# latest review-doc marker comment (doc namespace) — author-gated, anchored, never matches review-code/review-skill
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' <<<"$comments"

# latest review-skill marker comment (skill namespace) — author-gated, anchored, never matches review-code/review-doc
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-skill:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-skill:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' <<<"$comments"
```

Now resolve **per namespace**, latest-wins by timestamp:

- **review-code namespace** — the verdict is the **newest of {latest decisive review, latest
  review-code marker comment}** by timestamp (review `submitted_at` vs comment `created_at`).
  An `APPROVED` review or a `review-code: PASS … merge-ready` marker is PASS; a
  `CHANGES_REQUESTED` review or a `review-code: FAIL` marker is FAIL. The verdict's bound SHA
  is the marker's `@ <sha>` (or, for a native review, its `commit_id`). (The native
  approving-review path stays; it interleaves only with the review-code markers, never with
  review-doc.)
- **review-doc namespace** — the verdict is the **latest `review-doc` marker comment** by
  `created_at`; its bound SHA is the marker's `@ <sha>`. `review-doc: PASS … merge-ready` is
  PASS; `review-doc: FAIL … changes-requested` is FAIL. (review-doc lands no native review —
  it is comment-only, ADR 0058 — so there is no review path to fold in, and no review-vs-comment
  comparison to make.)
- **review-skill namespace** — the verdict is the **latest `review-skill` marker comment** by
  `created_at`; its bound SHA is the marker's `@ <sha>`. `review-skill: PASS … merge-ready` is
  PASS; `review-skill: FAIL … changes-requested` is FAIL. (review-skill is comment-only too,
  ADR 0058 — same single-record-type resolution as review-doc.) An **advisory** line
  (`review-skill: advisory — blocking-set PR …`) carries no `@ <sha>` and is **not** a PASS:
  the PR that earns it is in the §CP set, which Step 0 already refused — so it never reaches a
  merge decision here.

### Step 2b — SHA-staleness refusal (ADR 0058)

Each resolved verdict carries a bound SHA. A verdict authorizes a merge **only if it is bound
to the PR's current head** — this is what closes the masking race (a slower PASS bound to an
older head can never outrank a real FAIL on the live head) and the head-moved race (a PASS
bound to `X1` can never be consumed against `X2`). For each namespace's resolved verdict:

- **No bound SHA** (`sha == null` — a pre-0058 SHA-less marker) → `unverified (verdict not
  bound to current head)` → refuse.
- **Bound SHA ≠ current head** (neither is a prefix of the other — either may be abbreviated,
  so compare by prefix-match against `$CURRENT_HEAD`) → `unverified (verdict not bound to
  current head)` → refuse.
- **Bound SHA prefix-matches `$CURRENT_HEAD`** → the verdict is current; its polarity decides
  in the guard below.

```bash
# is verdict SHA $vsha bound to the current head? (prefix-match, either side may be abbreviated)
# Empty/absent $vsha MUST short-circuit to refuse FIRST: a jq `sha: null` reaches the shell as
# an empty string, and an unguarded `case "$CURRENT_HEAD" in ""*)` reduces to the glob `*` — which
# matches any head and would falsely report a legacy SHA-less marker as current (ADR 0058 rule 3).
is_current () { [ -n "$1" ] || return 1; case "$CURRENT_HEAD" in "$1"*) return 0;; esac; case "$1" in "$CURRENT_HEAD"*) return 0;; esac; return 1; }

# Extract each resolved verdict's bound SHA into a shell var — the load-bearing normalization:
# `// empty` renders a jq `sha: null` (a pre-0058 SHA-less / absent marker) as "" (NOT the literal
# "null"), so is_current's `[ -n "$1" ] || return 1` short-circuits to refuse exactly as designed.
# $verdict is the per-namespace resolved object emitted above ({state|body, at, sha}).
vsha="$(jq -r '.sha // empty' <<<"$verdict")"
is_current "$vsha" || echo "unverified (verdict not bound to current head) → refuse"
# null/empty $vsha → not current (legacy marker) → refuse. A jq `sha: null` must reach this helper
# as an empty string (or be short-circuited to refuse before the call) — never as the literal "null".
```

Then gate the merge on the classes present (Step 0):

1. For **each class present**, its namespace must have a latest verdict, it must be **bound to
   the current head** (Step 2b), and it must be PASS.
   - code present but the review-code namespace is empty → `unverified (no review-code PASS)`.
   - docs present but the review-doc namespace is empty → `unverified (no review-doc PASS)`.
   - skills present but the review-skill namespace is empty → `unverified (no review-skill PASS)`.
   - a verdict present but not bound to the current head → `unverified (verdict not bound to
     current head)` → refuse.
   - a mixed PR needs **each** present namespace resolved to a current-head PASS (e.g. a
     skill+code PR needs both `review-skill` and `review-code`).
2. If **any** required namespace's current-head verdict is **FAIL** → **do not merge.** The PR
   has unaddressed failures as its *current* state, even if an older PASS exists. Report
   `latest verdict is FAIL (<which gate>)` and stop; the fix round-trip is `write-code`'s
   (code) / the doc author's job, not yours.
3. If **every** required namespace's current-head verdict is PASS → guard 1 cleared, proceed to
   Step 3.

The polarity of the **newest current-head** event in each namespace is the only thing that
decides — an old PASS behind a newer FAIL never ships, an old FAIL behind a newer PASS does not
block, and a PASS bound to a *stale* head never ships at all.

#### A rebase/force-push staleness refusal means "re-review, then ship" — not "stuck"

The most common way to hit `unverified (verdict not bound to current head)` is **a rebase
before ship**: a PR fell behind `main`, someone rebased it (or force-pushed any new head),
and the prior `review-code`/`review-doc` PASS was bound to the *old* head. The rebase
staleness-invalidates that PASS — correctly, by design (ADR 0058): the verdict attests the
exact tree it reviewed, and a new head is, in principle, un-reviewed code. So this refusal is
**working as intended, not a fault to route around** — do **not** weaken the SHA-binding, and
do **not** stall waiting on a human.

The recovery is a **fresh review against the new head, then ship** — the verdict re-binds to
the current head and Step 2b clears. Concretely: re-run the matching gate (`review-code` for
code, `review-doc` for docs) against `$CURRENT_HEAD`, and once its latest verdict is a
current-head PASS, re-invoke `ship-it`. Whoever rebases owns this: the atomic path is **rebase
→ re-review → ship**, never *ship on a pre-rebase PASS* (which is self-contradictory — the
rebase invalidated that PASS the moment it landed). `write-code`'s ship/handoff flow documents
this atomic path; this refusal is its enforcement point, not a dead end (#310).

---

## Step 3 — Confirm the *gating* checks are green (one read, no polling)

You confirm checks; you do **not** own a wait-loop. Read the current check state once. The
human table and exit code can't cleanly separate red from pending, and neither tells a
*gating* check from an *informational* one — so read the per-check **names and states** and
classify by name, not by a bare bucket count:

```bash
gh pr checks $PR --json name,state,bucket --jq '.[] | "\(.bucket)\t\(.name)"'
# bucket ∈ pass | fail | pending | skipping | cancel
```

Not every red check blocks a merge. **`main` carries no required-status-check branch
protection**, so GitHub itself blocks on nothing; the SHA-bound merge gate is the
run-evidence bundle (Step 3.5) plus the review verdicts (Step 2), neither of which depends
on a preview deploy. So a check is **gating by default** and **informational only** when it
is on the explicit known-informational list below. Fail safe: an *unrecognized* red check
is treated as gating (it blocks) until it is deliberately classified — never the reverse.

**Known-informational checks** (a red here does **not** block and is **not** routed to
heal-ci): the `Deploy` workflow's preview deploys (`deploy (web)`). A preview-deploy infra
flake (e.g. `Secret probe returned 502`) is orthogonal to whether the PR is correct and
tested — see ADR [0061](https://github.com/kamp-us/phoenix/blob/main/.decisions/0061-ship-it-gating-check-set.md).

Classify in this order (`skipping`/`cancel` are non-blocking — neither a failure nor an
in-flight wait):

1. **Any *gating* check red** (a `fail` whose name is not known-informational) → do **not**
   merge. Route it to the self-heal lane: invoke [`/heal-ci`](../heal-ci/SKILL.md) with this
   PR/run, then report the result (e.g. `routed to heal-ci`). `heal-ci` decides
   flake-vs-defect; you only refuse on a gating red and hand off — you still do not merge.
2. **Else, any check pending** (no gating red, some unfinished) → report `checks pending —
   not yet merge-ready` and stop. The caller re-invokes you after CI settles; blocking on a
   multi-minute poll inside this atomic stage is out of scope.
3. **Else proceed to Step 4** — every gating check is green. If a *known-informational*
   check is red, it does not block: note it in the ledger (`informational check red (deploy
   (web)) — not gating`) and continue. Step 3.5 remains the SHA-bound backstop that the
   gating suite actually passed for this commit.

The gating set is, by construction, the suite the run-evidence bundle attests SHA-bound in
Step 3.5 (lint / format / typecheck, unit tests, validate skill frontmatter, integration
when it runs) — Step 3 is the cheap early read, Step 3.5 is the authority; if the two ever
disagree, Step 3.5 wins.

---

## Step 3.5 — Assert the run-evidence bundle (guard 2)

CI-green (Step 3) is an opaque rollup — it can't tell you *which* commit produced the green
run, or *what* the suites asserted. The **run-evidence bundle** is the SHA-bound proof
behind it: a structured manifest the CI producer (`.github/workflows/run-evidence.yml`)
emits per PR and uploads as a GitHub Actions artifact named `run-evidence` (ADR
[0054](https://github.com/kamp-us/phoenix/blob/main/.decisions/0054-run-evidence-bundle.md) §2/§3, stored per ADR
[0056](https://github.com/kamp-us/phoenix/blob/main/.decisions/0056-bundle-storage-transport.md)). This step is **additive** —
it does **not** replace the PASS-marker read (Step 2) or the CI-green read (Step 3); all
three must hold. The bundle is the evidence *behind* the marker, not a substitute for it.

Resolve the PR's head SHA, find the `run-evidence` workflow run for **that exact SHA**
(never just the latest run on the branch — the `head_sha` filter is what binds the evidence
to the commit being merged, ADR 0056 §2), download the `run-evidence` artifact, and read
`manifest.json`. The fetch is inlined here as a short `gh api` snippet rather than a shared
helper, on purpose: `review-code` runs the same fetch, but a shared file would couple two
control-plane skills at the seam — minor duplication is the cheaper trade now; extract a
helper later if a third consumer appears.

```bash
HEAD_SHA=$(gh api repos/$REPO/pulls/$PR --jq '.head.sha')

# the run-evidence workflow run for THIS exact head SHA (not a stale earlier push)
RUN_ID=$(gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100" \
  --jq '[.workflow_runs[] | select(.name=="run-evidence")]
        | sort_by(.created_at) | last | .id // empty')

# the run-evidence artifact id, then the manifest bytes
ART_ID=$(gh api "repos/$REPO/actions/runs/$RUN_ID/artifacts" \
  --jq '.artifacts[] | select(.name=="run-evidence") | .id' 2>/dev/null)
rm -rf /tmp/ship-it-bundle && mkdir -p /tmp/ship-it-bundle
gh api "repos/$REPO/actions/artifacts/$ART_ID/zip" > /tmp/ship-it-bundle/run-evidence.zip 2>/dev/null \
  && unzip -oq /tmp/ship-it-bundle/run-evidence.zip -d /tmp/ship-it-bundle
MANIFEST=/tmp/ship-it-bundle/manifest.json
```

Now assert the four things, **failing closed** on each — a missing bundle, an unreadable
schema, a stale commit, or any failed check refuses the merge with a *distinct* reason
string; never a silent pass:

```bash
# 1. The bundle must exist. No head-SHA run, no run-evidence artifact, or no manifest in it
#    → there is no proof this commit was run → refuse (ADR 0056: the artifact is the storage).
if [ -z "$RUN_ID" ] || [ -z "$ART_ID" ] || [ ! -s "$MANIFEST" ]; then
  echo "unverified (no run-evidence bundle)"; exit 0   # refuse — see Running it
fi

# 2. schemaVersion the gate understands. Fail closed on an unrecognized MAJOR rather than
#    misreading a newer shape (ADR 0056 §3 — schema skew is a visible refusal, not a trust hole).
#    schemaVersion is a JSON NUMBER (Manifest.ts: Schema.Number, SCHEMA_VERSION = 1); compare it
#    numerically inside jq (== 1) so a number/string skew can't fail-close a valid bundle. `SCHEMA`
#    is only the human-readable echo for the refusal message.
SCHEMA=$(jq -r '.schemaVersion // empty' "$MANIFEST")
jq -e '.schemaVersion == 1' "$MANIFEST" >/dev/null \
  || { echo "unverified (unsupported bundle schemaVersion: ${SCHEMA:-none})"; exit 0; }

# 3. bundle.commit MUST equal the PR head SHA — evidence not for THIS commit is no evidence
#    (ADR 0054 §1). A green run from an earlier push is stale → refuse.
BUNDLE_COMMIT=$(jq -r '.commit // empty' "$MANIFEST")
[ "$BUNDLE_COMMIT" = "$HEAD_SHA" ] || { echo "unverified (stale run-evidence bundle: commit $BUNDLE_COMMIT != head $HEAD_SHA)"; exit 0; }

# 4. EVERY checks[] entry must be `pass`. Any `fail` (or an empty checks[]) → refuse.
FAILED=$(jq -r '[.checks[]? | select(.status != "pass") | .name] | join(", ")' "$MANIFEST")
NCHECKS=$(jq -r '.checks | length' "$MANIFEST")
if [ "$NCHECKS" -eq 0 ] || [ -n "$FAILED" ]; then
  echo "run-evidence checks failed (${FAILED:-no checks present})"; exit 0   # refuse
fi
```

The four refusal reasons are **distinct and load-bearing** — each names *why* the bundle
didn't clear, so the report (and a human reading it) knows whether it's a missing producer
run, a producer/consumer schema skew, a stale push, or a real failing check:

- `unverified (no run-evidence bundle)` — no head-SHA run / no artifact / empty manifest.
- `unverified (unsupported bundle schemaVersion: <v>)` — a schema major the gate can't read.
- `unverified (stale run-evidence bundle: commit <c> != head <h>)` — bundle isn't for this commit.
- `run-evidence checks failed (<names>)` — at least one `checks[]` entry is `fail` (or none present).

Only when the bundle exists, is schema-`1`, is commit-bound to the head SHA, **and** every
`checks[]` entry is `pass` does guard 2 clear — proceed to Step 4. Like Step 2's FAIL and
Step 3's red, a bundle refusal is a **successful run that declines to merge**, not an error.

> **Verified against fixtures (AC #5).** The assertion logic is exercised against manifests
> the producer package's fixtures fold into — `packages/crabbox-manifest/src/fixtures.ts`
> provides `passingRunSummary` (every command `exitCode: 0` → all `checks[]` `pass`) and
> `failingRunSummary` (the `test` command `exitCode: 1` → a `fail` check), which the adapter
> emits as `schemaVersion: 1` manifests stamped with `--commit`. Construct the two cases and
> run the assertions: a passing manifest stamped with `commit` == the PR head SHA clears all
> four; the failing one trips assertion 4 (`run-evidence checks failed (test)`); the same
> passing manifest stamped with a different `commit` trips assertion 3 (`stale`); a
> deleted/empty `manifest.json` trips assertion 1 (`no run-evidence bundle`); a manifest with
> `schemaVersion: 2` trips assertion 2. Each refusal is distinct — no silent pass.

```bash
# build a passing + failing manifest from the package fixtures, then run the four assertions
# against each (commit-mismatch and missing-bundle are the same passing manifest mutated):
cd packages/crabbox-manifest
HEAD_SHA=deadbeef
pnpm adapter --run-summary <(node -e 'console.log(JSON.stringify(require("./src/fixtures").passingRunSummary()))') \
  --commit "$HEAD_SHA" --environment test --output /tmp/pass.json   # all checks pass → clears
pnpm adapter --run-summary <(node -e 'console.log(JSON.stringify(require("./src/fixtures").failingRunSummary()))') \
  --commit "$HEAD_SHA" --environment test --output /tmp/fail.json   # test exit 1 → assertion 4 refuses
# /tmp/pass.json with commit != $HEAD_SHA → assertion 3 (stale); rm /tmp/pass.json → assertion 1
```

---

## Step 4 — Squash-merge

Every guard cleared: not a control-plane PR (Step 0), the required gates' latest verdicts
are a current-head PASS (Step 2/2b), checks are green (Step 3), and the run-evidence bundle
is present, commit-bound, and all-`pass` (Step 3.5). Ship it with a squash merge so the issue's
whole branch collapses to one commit on `main`:

```bash
gh pr merge $PR --squash
```

The merge auto-closes the linked issue via its `Fixes #<ISSUE>` — that is the loop
closing. Do not separately close the issue; let the `Fixes` seam do it.

---

## Step 5 — Confirm the loop closed

Verify the terminal state rather than assuming the merge took:

```bash
gh api repos/$REPO/pulls/$PR --jq '{merged, merged_at}'
gh api repos/$REPO/issues/$ISSUE --jq '{state, state_reason}'
```

The issue should now read `state: closed`, `state_reason: completed`. If it didn't
auto-close (a missing/garbled `Fixes #N`), close it explicitly with a one-line note
pointing at the merged PR — but record that the seam was broken so it can be fixed
upstream.

---

## Running it

A single invocation ships one PR end to end: classify the diff against the control-plane
boundary and refuse if it touches one (Step 0, guard 0), resolve the PR ↔ issue (Step 1),
resolve the latest verdict per required gate namespace, refuse any verdict not bound to the
PR's current head (Step 2b, ADR 0058), and merge only if every required one is a current-head
PASS (Step 2, guard 1), confirm the gating checks are green (Step 3), assert the SHA-bound run-evidence bundle
exists / is schema-readable / is commit-bound / is all-`pass` (Step 3.5, guard 2), squash-merge
(Step 4), confirm the issue closed (Step 5).

Report back a tight terminal ledger — nothing else, because the merge itself is the
durable record:

```
PR #<PR> — issue #<ISSUE>
branch: <head ref>
PR url: <html_url>
merged: yes | no (<reason if no>)
issue closed: yes | no
```

If you refused to merge, the reason line is the whole point: `blocking — manual merge`,
`unverified (no review-code PASS)`, `unverified (no review-doc PASS)`, `unverified (no
review-skill PASS)`, `unverified (verdict
not bound to current head)` (a SHA-less or stale-head verdict — Step 2b, ADR 0058), `latest
verdict is FAIL (<gate>)`, `routed to heal-ci` (a gating red check, handed to the self-heal lane),
`checks pending`, `no linked issue`, or a run-evidence refusal (Step 3.5):
`unverified (no run-evidence bundle)`, `unverified (unsupported bundle schemaVersion: <v>)`,
`unverified (stale run-evidence bundle: …)`, or `run-evidence checks failed (<names>)`. A
refusal is a successful run — shipping the wrong PR is the only failure mode that matters.

## Conventions

This skill is the terminal stage of a suite (`report` → `triage` → `plan-epic` →
`review-plan` → `write-code` → `review-code` / `review-doc` → **`ship-it`**) that turns GitHub issues into an
agent-operable pipeline. The shared label semantics and the body/comment/dependency/marker
formats live in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) — you are
the merge step named as the reader of format 5; the decision to give the pipeline a single
merge authority is ADR [0048](https://github.com/kamp-us/phoenix/blob/main/.decisions/0048-ship-it-merge-actor.md), and the
control-plane boundary you enforce is ADR
[0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md) (supersedes
[0049](https://github.com/kamp-us/phoenix/blob/main/.decisions/0049-pipeline-ships-code-not-itself.md)). Your input is a
non-control-plane PR a gate signalled merge-ready; your output is a merged PR, a closed
issue, and a closed loop. You are the one stage with merge authority — guard it: never merge
a control-plane PR, and never merge on the absence of a failure, only on the presence of a
verified PASS.
