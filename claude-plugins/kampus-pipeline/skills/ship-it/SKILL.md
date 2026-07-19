---
name: ship-it
description: Ship one verified PR on the configured target repo — the authorized merge step the rest of the pipeline defers to. Given a PR number, assert the matching gate has signalled PASS (review-code for code, review-doc for docs, review-skill for skills), confirm CI is already green plus the SHA-bound run-evidence bundle, then enqueue for a squash merge with `gh pr merge --auto` (no method flag — the queue owns the SQUASH method) — the merge queue owns the final, async merge, so success is "enqueued + green" (QUEUED → auto-merges on green) and the linked issue auto-closes async when the merge lands (ADR 0132) — then a bounded post-enqueue reconcile watches a batch window to catch a merge-queue ejection (a dropped PR — still open, no longer queued, not merged), routing an ejected PR back to repair/re-queue instead of reporting a silent false success. When the ship was a dark feature ship it surfaces a release queue for the humans (deploy is the agent's boundary, release is human; ADR 0083). For a control-plane PR (.claude/.github + the gate-critical skills) it is APPROVAL-AWARE (ADR 0135, amending 0053) — it enqueues the §CP PR only once a @kamp-us/control-plane team member has APPROVED it at the current head (all machine gates still green), else STOPS at "awaiting control-plane approval" — human judgment via the approval, pipeline mechanics via the enqueue. Trigger on "ship #N", "ship it", "it's merge-ready, ship it", "close the loop on #N", "merge #N", "/ship-it". This is the terminal stage of the issue-intake pipeline: it consumes the merge-ready signal the gates produce and is the ONLY skill granted merge authority.
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

- **CONTROL PLANE — enqueue only on a control-plane-team approval.** Any PR touching `.claude/**`,
  `.github/**`, or one of the **gate-critical skills** is the agent control plane: agent
  instructions/tools/hooks (`.claude`), CI enforcement (`.github`), and the verification/merge
  machinery + marker contract (the gate-critical skills). A bad merge here is a serious security
  concern — self-modification of the guardrails, or CI/secret exfiltration. Under ADR
  [0135](https://github.com/kamp-us/phoenix/blob/main/.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)
  (amending 0053's merge model) the pipeline **never self-merges a §CP PR on its own machine
  gates alone** — but it **does enqueue** one once a `@kamp-us/control-plane` **team member has
  APPROVED it at the current head**. Human judgment enters via the approval; the pipeline owns the
  mechanics. If the diff touches even one such file, you check for a current-head team approval
  (see Step 0): **present** → enqueue like any PR; **absent** → STOP at `awaiting control-plane
  approval`, never enqueue.

  The **gate-critical skills** are `claude-plugins/kampus-pipeline/skills/ship-it/**`, `claude-plugins/kampus-pipeline/skills/review-code/**`,
  `claude-plugins/kampus-pipeline/skills/review-doc/**`, `claude-plugins/kampus-pipeline/skills/review-skill/**`, `claude-plugins/kampus-pipeline/skills/review-plan/**`, and
  `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` — the verification/merge gates plus the shared
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
  superseding 0063's `review-code` routing) — and a `@kamp-us/control-plane` team member reads that
  verdict, then **approves** the PR, after which `ship-it` enqueues it (ADR 0135; the approval is
  the human-judgment gate, the enqueue is the pipeline's). **Every OTHER `claude-plugins/kampus-pipeline/skills/**`** (triage, plan-epic, write-code, heal-ci, report, …) stays
  **non-blocking** — `review-skill`-routed and auto-merged on a PASS, because those skills
  neither merge nor verify, so a bad edit still has to clear the gate that does. ADR 0065's
  blocking rule is **unchanged** by 0073: `review-skill` is the *verdict* gate; merge-authority
  (blocking) is the *separate* axis 0065 owns, and 0065 stands verbatim until a later decision
  retires it against `review-skill`'s evidence (ADR 0073 §4).
- **NON-BLOCKING — autonomous.** Everything else — `apps/**` (every app worker), `packages/**`,
  `.decisions/**` (**except a guard-touching ADR** — see next paragraph), `.patterns/**`, and
  other prose docs. These are product or knowledge
  artifacts; they are gated for quality, but a human at the merge adds no security value, so
  you ship them once the matching gate PASSes.

Note `.decisions/**` and `.patterns/**` are **non-blocking** under 0053 — they auto-merge
through `review-doc` (the boundary moved off "harness vs not" to "control plane vs not"). **The
one exception (ADR [0164](https://github.com/kamp-us/phoenix/blob/main/.decisions/0164-guard-relaxing-adr-cp-gate.md),
#2191): a guard-touching `.decisions/**` ADR is §CP.** An ADR that relaxes/amends a documented
guard is control-plane by nature, so Step 0 classifies a `.decisions/**` file §CP by its
**content** (a conservative, fail-closed guard-vocabulary probe — not an author-declared tag) and
holds it for a founder/control-plane approval rather than auto-shipping it on a `review-doc` PASS.

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
2. **Merge only on a commit-bound run-evidence bundle whose every check passed —** *when the
   repo produces one.* Beyond the marker, the run-evidence bundle (Step 3.5) is the SHA-bound
   proof behind the green: a missing bundle, an unreadable schema, a `commit` that isn't the
   head SHA (stale), or any `checks[]` entry that isn't `pass` → you refuse. This is
   **additive** to the PASS-marker and CI-green reads, not a replacement (ADR 0054 §3 / 0056).
   In a foreign repo that ships no `run-evidence` producer, guard 2 is N/A and the gate falls
   back to checks-green (Step 3) — a producer-presence degradation, not a per-PR override
   (ADR 0086).
3. **You are the only skill that merges.** If you find yourself wanting to merge a PR a gate
   hasn't passed, the answer is to route it back through that gate (`review-code` /
   `review-doc`), not to merge it here.
4. **Read-only on git working state** — the single canonical rule lives in
   [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §RO; cite it, don't restate
   the prohibition (the five verbatim copies were the #375-class drift §RO closes). You ship
   entirely over `gh api` / `gh pr merge` (the merge happens **server-side**), so you have **no
   reason to touch the local working tree at all** — read PR state read-only over `gh api`; you
   never need a checkout to ship.
5. **An unresolved inline review thread (human or bot) blocks the merge — and the default is
   route-back, never auto-dismiss.** Before you enqueue, read the PR's unresolved inline threads
   (Step 3.6): a **substantive** one refuses the ship like a FAIL (routed back to `write-code`); a
   **genuine nit** may be resolved **only with an explicit written rationale**; **in doubt, treat
   it as substantive and route back** (ADR
   [0158](https://github.com/kamp-us/phoenix/blob/main/.decisions/0158-unresolved-review-thread-is-a-merge-gate.md)).
   A shipper that "resolves" a real objection just re-creates the throw-away one layer down —
   never blanket-resolve threads to clear the gate.

## The merge-ready signals

The pipeline runs **three artifact-class gates** (one per class), each landing its verdict as
a first-line marker comment — **plus `review-design`, an additive UI-quality gate** that a
UI-affecting PR requires *alongside* its class gate (a UI PR under `apps/web/src` is also code,
so it needs **both** `review-code` and `review-design`; `review-design` never replaces a class
gate, it layers on):

Every verdict is **SHA-bound** — its first line carries the head it reviewed (`@ <sha>`), and
you refuse any verdict not bound to the PR's *current* head (Step 2b, ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)):

- **product code** (`apps/**` — every app worker, not just `apps/web` — `packages`, other code) → `review-code`, whose marker is
  `review-code: PASS @ <sha> — merge-ready` or `review-code: FAIL @ <sha> — not merge-ready`
  (canonical shape: [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §5).
  `review-code` can also land a native **approving review** (`event=APPROVE`), whose
  `commit_id` is its bound SHA.
- **docs** (`.decisions`, `.patterns`, prose `*.md` outside `.claude`/`.github`, outside
  `claude-plugins/kampus-pipeline/skills/**`, and outside the code roots `apps/**`/`packages/**` — a package/app-internal README
  is `review-code`'s scope, not this class; see Step 0) → `review-doc`, whose marker is
  `review-doc: PASS @ <sha> — merge-ready` or
  `review-doc: FAIL @ <sha> — changes-requested` (canonical shape: §6). `review-doc` is
  **comment-only** — it never lands a native review (ADR 0058), so the doc lane is a single
  comparable record type, not a review-vs-comment mix.
- **skills** (`claude-plugins/kampus-pipeline/skills/**`) → `review-skill`, whose marker is
  `review-skill: PASS @ <sha> — merge-ready` or `review-skill: FAIL @ <sha> — changes-requested`
  (canonical shape: §6.5). `review-skill` is **comment-only** like `review-doc` (ADR 0058). This
  **supersedes ADR 0063's** `claude-plugins/kampus-pipeline/skills/**` → `review-code` routing (ADR 0073 §4): a skill is a
  behavioral artifact, gated by the gate built for it.
- **UI-affecting** (a changed path under `apps/web/src`, a `*.tsx` file, or a style surface —
  the same UI-affecting-PR detection the reviewer agent uses to *dispatch* `review-design`;
  see the [UI-affecting detection](#the-ui-affecting-detection-must-agree-with-the-reviewer) note
  below) → `review-design`, whose marker is `review-design: PASS @ <sha> — merge-ready` or
  `review-design: FAIL @ <sha> — changes-requested`. `review-design` is **comment-only** like
  `review-doc`/`review-skill` (ADR 0058) — a single comparable record type, no native review.
  Unlike the three class gates, `review-design` is **additive, not a class**: it is required
  **alongside** the PR's artifact-class gate(s) whenever the diff is UI-affecting, never
  instead of one (a UI PR under `apps/web/src` is has-code, so it needs `review-code`'s PASS
  **and** `review-design`'s).

The marker-comment path is the **default** to expect: the single operator on this repo
(`usirin`) cannot post an approving review on their own PR under org branch rules, so on
the common path the gate falls back to a marker comment. **You are the consumer the markers
were written for** — without you, they are inert verdicts nobody acts on. Recognize a marker
tolerantly by shape (`review-code: PASS @ <sha>` … `merge-ready`, `review-code: FAIL @ <sha>`
… `not merge-ready`, `review-doc: PASS @ <sha>` … `merge-ready`, `review-doc: FAIL @ <sha>` …
`changes-requested`, `review-skill: PASS @ <sha>` … `merge-ready`, `review-skill: FAIL @ <sha>`
… `changes-requested`, `review-design: PASS @ <sha>` … `merge-ready`, `review-design: FAIL @
<sha>` … `changes-requested`), not by exact dashes — but the `@ <sha>` is required, and a
SHA-less legacy marker resolves to `unverified`, not PASS.

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
# Isolation preflight FIRST. ship-it is §RO — it ships entirely over `gh api` / `gh pr merge`
# (server-side) and materializes NO head via local git — so it should never touch the primary
# checkout's git state. This is the defense-in-depth belt: if this ship-it spawn expected worktree
# isolation (shipper agent-type) but the #2440 harness no-op dropped it onto the shared PRIMARY
# checkout ($WORKTREE_ROOT unset — the #2452/#2453 condition), fail closed LOUD and route up rather
# than run any git op there. Single-sourced in gh-issue-intake-formats.md §RO-iso (ADR 0172; the
# write-code wt_preflight sibling). A genuine standalone `/ship-it` on the owner's checkout still proceeds.
# This iso_preflight is ship-it's whole stake in the #2690 worktree-hardening consolidation: LAYER 1
# (prevention) lives here, while LAYER 2 (the clean-tree assertion + the stage-all `git add -A` ban)
# has NO surface in ship-it — it stages/commits nothing — so it is enforced upstream in the pre-bash
# hook + write-code/review-code, not duplicated here.
iso_preflight ship-it || exit 1   # ../gh-issue-intake-formats.md §RO-iso — define it there, cite here
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename'   # --paginate + streaming --jq: full set past file #100 (the API caps per_page at 100; #725)
```

Classify each path. The **control-plane / blocking set** is defined **once** in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §CP — cite that regex, don't
re-hard-code the path list (the three independent copies are the #375 drift class §CP closes,
ADR 0073 §6). And **resolve it from `origin/main` at run time, not from the copy embedded in
this skill body** — that embedded copy travels in the *injected snapshot*, which can lag
`origin/main` even when the on-disk file is current, so a pre-amendment snapshot once
auto-merged a now-control-plane PR (#981). The bash below reads §CP freshly from `origin/main`
and **fails closed** (treats every path as control-plane → refuses) if that read can't be made:

- **control plane (blocking):** matches the §CP set — `.claude/**`, `.github/**`, or a
  **gate-critical skill** (`claude-plugins/kampus-pipeline/skills/ship-it/**`, `claude-plugins/kampus-pipeline/skills/review-code/**`,
  `claude-plugins/kampus-pipeline/skills/review-doc/**`, `claude-plugins/kampus-pipeline/skills/review-skill/**`, `claude-plugins/kampus-pipeline/skills/review-plan/**`,
  `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`). A gate-critical skill is blocking **for merge
  authority** (ship-it refuses → manual human merge, ADR
  [0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md),
  **unchanged** by 0073) AND is **routed to `review-skill`** for its verdict (ADR
  [0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md), superseding 0063's
  `review-code` routing) — the two axes are independent. The blocking refusal short-circuits in
  the **Routing** step below, *before* the namespace check, so the `review-skill` routing stays
  correct for the human-read verdict: gate-critical skills are **skill-class for ROUTING,
  blocking for MERGE**. Every OTHER `claude-plugins/kampus-pipeline/skills/**` is **non-blocking** — skill-class for routing
  and auto-merged on a `review-skill` PASS.
- **skills:** under `claude-plugins/kampus-pipeline/skills/**` (the `^claude-plugins/kampus-pipeline/skills/` probe) → **skill-class**, requiring a
  `review-skill` PASS. A skill is a behavioral artifact, gated by `review-skill`, not the code
  AC-gate nor the doc hygiene-gate (ADR 0073 §4, superseding ADR
  [0063](https://github.com/kamp-us/phoenix/blob/main/.decisions/0063-skills-are-code-gated.md)).
- **code:** under any app worker, a package, a standalone stack, or the glossary (`apps/**`,
  `packages/**`, `infra/**`, or `.glossary/**` — the `^(apps|packages|\.glossary|infra)/` probe,
  covering **every** `apps/<app>` worker, not just `apps/web`, and every `infra/**` standalone stack
  (ADR 0057)); a source path matching none
  of the four probes still defaults to code, requiring a `review-code` PASS, so nothing under-gates.
  The probe spans `apps/**` (not `apps/web/**`) so a future second worker like `apps/<other>/**` — code
  **or** README — is `review-code`-gated like `apps/web`; `infra/**` is `review-code`-gated so a
  package README under a standalone stack rides its code artifact (ADR 0057; #1987); and `.glossary/**`
  is `review-code`-gated because Step 3c reads + enforces it (#912/#919); it agrees exactly with the
  docs probe's `apps/**`/`packages/**`/`infra/**`/`.glossary/**` exclusion below (the two must name the
  same code roots, or such a path would class as neither code nor docs and slip through ungated — #663).
- **docs:** `.decisions/**`, `.patterns/**`, or a prose `*.md` *outside* `.claude`/`.github`,
  **outside `claude-plugins/kampus-pipeline/skills/**`**, **outside the code roots `apps/**`/`packages/**`/`infra/**`**,
  **and outside `.glossary/**`** — exactly
  `review-doc`'s verification scope. `claude-plugins/kampus-pipeline/skills/**` is the skill class, an `*.md` under
  `apps/**`/`packages/**`/`infra/**` (a package/app-internal README, CHANGELOG, etc.) ships with its code
  artifact and is **`review-code`'s** scope, and `.glossary/**` is owned by `review-code` Step 3c —
  so all four are carved out of docs *before* the `.md$`
  match. The docs class is thus the surface a `review-doc` PASS can actually gate — see the
  scope-consistency note after the routing.

```bash
FILES=$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename')   # --paginate + streaming --jq: full set past file #100 (the API caps per_page at 100; the grep probes below aggregate the concatenated lines) (#725)
# §CP travels in the INJECTED skill snapshot, which can lag origin/main even when the on-disk file
# is current — a pre-amendment snapshot once auto-merged a now-control-plane PR (#981).
# §CP boundary is single-sourced in pipeline-cli (control-plane-paths/control-plane-re.ts, #2761);
# run `pipeline-cli control-plane-paths` to print it. It is re-resolved from origin/main right below
# (the #981 anti-self-authorization read), so this is only a fail-closed sentinel, never the live source.
CONTROL_PLANE_RE='.'   # fail-closed default: every path is control-plane until origin/main resolves
# Re-resolve §CP from origin/main at run time so a stale snapshot can't mis-classify a now-control-plane
# PR as auto-mergeable (#981). ADR 0073 §6 names gh-issue-intake-formats.md the single source; read it
# freshly via REST raw (never GraphQL, top-of-skill rule). origin/main's line wins over the snapshot.
CP_LIVE="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null | grep '^CONTROL_PLANE_RE=' | head -n1 || true)"
if [ -n "$CP_LIVE" ]; then
  CONTROL_PLANE_RE="$(printf '%s' "$CP_LIVE" | sed "s/^CONTROL_PLANE_RE='//; s/'$//")"   # classification tracks origin/main, not the snapshot's age (AC1/AC2)
else
  CONTROL_PLANE_RE='.'   # FAIL CLOSED: can't read origin/main's boundary ⇒ treat EVERY path as control-plane (refuse), never trust the possibly-stale snapshot
fi
echo "$FILES" | grep -Eq "$CONTROL_PLANE_RE" && echo "BLOCKING"   # control plane: .claude/.github + the gate-critical skills (ADR 0065) + the enforcement-guard packages (ADR 0100/0103); other skills/** auto-merge on a review-skill PASS (ADR 0073)
# §CP CONTENT clause (ADR 0164/#2191): a .decisions/** ADR is §CP by PATH only if it also matches
# CONTROL_PLANE_RE (it doesn't) — but a guard-RELAXING ADR is control-plane by NATURE and path can't
# tell it from an ordinary one. So classify a touched .decisions/** ADR §CP when its CONTENT cites or
# amends a documented guard. This probe is the SHARED verb `pipeline-cli guard-content-probe` (issue
# #3645, founder ruling #3416) — the ONE content probe the review gate and the driver (via
# trivial-diff) ALSO call, so a guard-touching ADR classifies §CP consistently at every stage, not
# only here. The GUARD_ADR_RE vocabulary stays single-sourced in gh-issue-intake-formats.md §CP; the
# verb reads it from the local checkout (immune to the #981 injected-snapshot staleness — it reads
# disk, not this skill's prompt copy). FAIL CLOSED: an unreadable ADR body (delete/404) ⇒ §CP —
# never auto-ship an ADR that couldn't be read and proven guard-free (the verb resolves this itself).
HEAD_SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"
echo "$FILES" | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
  [ -z "$adr" ] && continue
  gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null \
    | node packages/pipeline-cli/src/bin.ts guard-content-probe classify --path "$adr" >/dev/null \
    && echo "BLOCKING ($adr — guard-touching ADR ⇒ §CP, ADR 0164)"
done
# The has-code/has-docs/has-skills probes are single-sourced as canonical HAS_*_RE= lines in
# gh-issue-intake-formats.md §CLASS and re-resolved from origin/main here (like CONTROL_PLANE_RE/
# UI_RE, #981) so this snapshot can't mis-classify — and so the reviewer (which consumes the SAME
# lines) fans across every present class in lockstep with what ship-it requires (#2383). The reviewer
# and this step both run `pipeline-cli class-probe classify` (which parses these SAME §CLASS lines —
# no third copy) as the deterministic class set, so `required == dispatched` can't diverge by an
# eyeball miss the way `.glossary/**` did on PR #2430 (#2434). FAIL CLOSED: an unreadable source ⇒
# dispatch/require the gate. The literals below are the fail-closed reference, NOT the live decision
# source — §CLASS is the source:
#   gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' | pipeline-cli class-probe classify
HAS_CODE_RE='^(apps|packages|\.glossary|infra)/'
HAS_SKILLS_RE='^claude-plugins/[^/]+/(skills|agents)/|^\.claude-plugin/'
HAS_DOCS_EXCLUDE_RE='^(claude-plugins|apps|packages|\.glossary|infra)/'
HAS_DOCS_RE='^(\.decisions|\.patterns)/|\.md$'
CLASS_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
reresolve_re() { live="$(printf '%s\n' "$CLASS_RAW" | grep "^$1=" | head -n1 || true)"; if [ -n "$live" ]; then printf '%s' "$live" | sed "s/^$1='//; s/'\$//"; else printf '%s' "$2"; fi; }
HAS_CODE_RE="$(reresolve_re HAS_CODE_RE '.')"
HAS_SKILLS_RE="$(reresolve_re HAS_SKILLS_RE '.')"
HAS_DOCS_EXCLUDE_RE="$(reresolve_re HAS_DOCS_EXCLUDE_RE '\$^')"   # fail-closed: exclude NOTHING ⇒ every path reaches the doc test
HAS_DOCS_RE="$(reresolve_re HAS_DOCS_RE '.')"                     # fail-closed: every path is a doc
echo "$FILES" | grep -Eq "$HAS_SKILLS_RE" && echo "has-skills"   # → review-skill (ADR 0073/0150); §CP-blocking for merge via CONTROL_PLANE_RE above
echo "$FILES" | grep -Eq "$HAS_CODE_RE" && echo "has-code"       # → review-code; the has-code roots agree with the docs-exclusion below in lockstep (§CLASS/§DOC, #663/#919/#1987)
echo "$FILES" | grep -Ev "$HAS_DOCS_EXCLUDE_RE" | grep -Eq "$HAS_DOCS_RE" && echo "has-docs"   # → review-doc; carve out code roots/skills/.glossary first, then test for a doc path (§DOC contract)
# No-class fail-closed (#2765): a NON-EMPTY diff whose files match NONE of the three classes above
# — root tooling outside the code roots (biome-plugins/**, biome.jsonc, turbo.json) — must NOT ship
# un-gated. `pipeline-cli class-probe classify` (the live decision source above) folds this in: any
# unclassified changed file rides has-code → review-code, so a non-empty diff never requires zero
# gates. This is the §CLASS "no-class fail-closed" rule, NOT a widened HAS_CODE_RE (that is #2761).
# UI probe → review-design (ADDITIVE, not a class): a changed path under apps/web/src — the
# rendered frontend surface (React components, styles, tokens, routes). `pipeline-cli class-probe
# classify` above ALSO emits `has-ui` (it parses this same UI_RE from its single source,
# ship-it/SKILL.md) — so the reviewer fan dispatches review-design off the SAME deterministic probe
# it fans the class gates from, rather than eyeballing the files and skipping it (the #2483 deadlock;
# #2485). Like CONTROL_PLANE_RE/GUARD_ADR_RE above, the literal below is the fail-closed REFERENCE +
# the validate-gate-path-drift lockstep target, NOT the live decision source: it is re-resolved from
# origin/main right after, so an injected skill snapshot that predates the review-design gate can't
# silently DROP the UI probe and slip a UI PR past the gate (#2341 — the #981 idiom, previously only
# on §CP/GUARD, now extended to UI_RE). ship-it/SKILL.md@main's `UI_RE=` line is the ONE live source;
# reviewer.md, class-probe, AND review-design's Step 0 off-ramp all re-resolve the SAME line from the
# same ref, so required-gate == dispatched-gate == satisfiable-gate holds by construction — all sides
# read live main, not independently-aging snapshots. When a second app worker is added, generalize
# this one live UI_RE to apps/**/src and every side tracks it.
# SCOPE (#2470): UI_RE is `^apps/web/src/` ONLY — a `.tsx`/`.css` OUTSIDE apps/web/src (a Hono
# server-JSX file, a `.tsx` test fixture, a non-web `.css`) has no rendered surface, so it is NOT
# design-gate work and must NOT mint a required review-design. The earlier `|\.tsx$|\.css$` branches
# made the *require* predicate a superset of review-design's own dispatch/off-ramp predicate
# (`^apps/web/src/`): a non-web `.tsx` was required-but-unroutable — the dispatched review-design run
# off-ramped with no marker and ship-it deadlocked on a review-design PASS no run could produce.
# IN-SRC TEST CARVE-OUT (#3071): a change whose apps/web/src paths are ALL test/spec files renders no
# surface, so it must NOT mint a required review-design either — the src-colocated `*.test.tsx` next to
# a component (the established sibling-colocation convention) stalled #3046/#3047 at ship on a gate no
# run could satisfy. ERE (grep -E) has no negative lookahead, so a single UI_RE can't express "under
# src, but not a test" — mirror §CLASS's has-docs carve-then-test: strip test/spec files FIRST, THEN
# test for a UI path. A real component (apps/web/src/**/*.tsx non-test) or a mixed component+test diff
# survives the carve and STILL gates; only an all-test/spec src diff is exempted.
UI_RE='^apps/web/src/'
UI_EXCLUDE_RE='\.(test|spec)\.tsx?$'
UI_RAW="$(gh api "repos/$REPO/contents/claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
UI_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_RE=' | head -n1 || true)"
UX_LIVE="$(printf '%s\n' "$UI_RAW" | grep '^UI_EXCLUDE_RE=' | head -n1 || true)"
if [ -n "$UI_LIVE" ]; then UI_RE="$(printf '%s' "$UI_LIVE" | sed "s/^UI_RE='//; s/'$//")"; else UI_RE='.'; fi   # FAIL CLOSED: can't read origin/main's UI_RE ⇒ '.' ⇒ every path UI-affecting ⇒ REQUIRE review-design, never silently skip (#2341)
if [ -n "$UX_LIVE" ]; then UI_EXCLUDE_RE="$(printf '%s' "$UX_LIVE" | sed "s/^UI_EXCLUDE_RE='//; s/'$//")"; else UI_EXCLUDE_RE='$^'; fi   # FAIL CLOSED: unreadable ⇒ '$^' never-match ⇒ carve out NOTHING ⇒ every apps/web/src path (incl. tests) gates review-design
echo "$FILES" | grep -Ev "$UI_EXCLUDE_RE" | grep -Eq "$UI_RE" && echo "has-ui"   # carve test/spec first, THEN require review-design ALONGSIDE the class gate(s)
```

**Routing:**

- If **any** file is control plane (the §CP set — `.claude/**`, `.github/**`, or a
  gate-critical skill) **OR any touched `.decisions/**` ADR matched the guard-touching content
  probe above** (a guard-relaxing/amending ADR is control-plane by nature — ADR
  [0164](https://github.com/kamp-us/phoenix/blob/main/.decisions/0164-guard-relaxing-adr-cp-gate.md),
  #2191; its `review-doc` verdict routing is unchanged, only merge-authority moves) → the PR is
  **§CP: APPROVAL-GATED** (not a blanket refuse — ADR
  [0135](https://github.com/kamp-us/phoenix/blob/main/.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md),
  amending 0053's merge model). Run the **deterministic §CP cardinality check** (the
  [§CP approval gate](#step-0-cp-approval-gate) below, ADR 0175):
  - **discharge** → the human-judgment gate is satisfied; **carry on** into Step 2's normal machine
    gates (matching-gate SHA-bound PASS, CI green, run-evidence). Once those pass, ENQUEUE exactly
    like a non-§CP PR (`gh pr merge --auto`, no method flag — the queue owns the SQUASH method;
    QUEUED → auto-merges on green; §CP PRs now
    enter the ADR 0132 queue too). §CP carries **one extra** gate — the team approval — layered on
    the same machine gates every PR clears.
  - **stop** (the cardinality branch's required current-head signal is absent, or the team is
    empty) → **STOP.** Report `awaiting control-plane approval` and stop; do **not** enqueue. This
    **replaces** the old blanket refuse.

  This holds even if the rest of the diff is clean code/docs/skills — a mixed PR that touches the
  control plane needs the team approval for the whole PR, and should be split so the non-§CP half
  can flow without it. The §CP gate short-circuits **before** the namespace check below, so it never
  conflicts with the fact that a gate-critical `claude-plugins/kampus-pipeline/skills/**` PR is still
  `review-skill`-routed (ADR 0073): the routing decides *which gate's verdict the human reads*, the
  §CP approval gate decides *whether the enqueue is unblocked*. A `claude-plugins/kampus-pipeline/skills/**`
  PR that touches **no** gate-critical skill is **not** §CP — it flows through `review-skill` and
  auto-merges on a PASS with no team approval.

  <a id="step-0-cp-approval-gate"></a>
  **The §CP approval gate — a deterministic team-cardinality check, resolved over `gh api` REST
  (ADR [0175](https://github.com/kamp-us/phoenix/blob/main/.decisions/0175-cp-self-approval-cardinality-check.md)).**
  The discharge is a **function of `@kamp-us/control-plane` team shape**, never agent judgment — the
  same §CP conditions produce the same verdict across agents (killing the #2435 non-determinism where
  identical single-owner PRs merged in one run and were refused in another). The branch keys on `N`,
  the count of present, active, human control-plane members, exactly as ADR 0175's `case "$N"`
  reference specifies:
  - **`N == 0`** (empty team) → **STOP, fail closed** — no accountable human to discharge the boundary.
  - **`N == 1`, sole owner *is* the PR author** → a current-head **self-approval marker** by the sole
    owner discharges (the single-owner degenerate case; GitHub blocks native self-approval, so the
    signal is a marker comment — ADR 0135/0175).
  - **`N == 1`, sole member *is not* the author** → that member's current-head **approval** discharges.
  - **`N >= 2`** (ADR 0135's two-person control, unchanged) → a current-head **APPROVED review by a
    control-plane member who is NOT the author** discharges; a self-approval never does.

  Every discharge signal is **bound to the PR's current head** — a review's `commit_id` (the commit
  it was submitted against, per the [GitHub REST reviews resource](https://docs.github.com/rest/pulls/reviews))
  or the self-approval marker's `@ <sha>` equals the PR head SHA. A stale signal on a superseded head
  **does not count** — this retains ADR
  [0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)'s
  SHA-staleness rule (and the `dismiss_stale_reviews_on_push` the Phase-3 ruleset sets). The branch
  itself lives in the pure, unit-tested `cp-cardinality` core (`packages/pipeline-cli`) — the single
  source ship-it runs, so the verdict cannot drift across shippers (the class-probe/control-plane-paths
  precedent). Resolve the roster + the two signals over REST, never GraphQL, then decide:

  ```bash
  # ADR 0175: DETERMINISTIC §CP discharge keyed on control-plane team cardinality, not judgment.
  ORG="${REPO%%/*}"                                            # owner half of owner/repo
  # N = present, active, human control-plane members (REST, never GraphQL — ADR 0135/0175)
  MEMBERS="$(gh api --paginate "orgs/$ORG/teams/control-plane/members?per_page=100" --jq '.[].login')"
  AUTHOR="$(gh api "repos/$REPO/pulls/$PR" --jq '.user.login')"
  HEAD="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"    # every signal binds THIS head (ADR 0058)
  sha_binds_head() { [ -n "$1" ] || return 1; case "$HEAD" in "$1"*) return 0;; esac; case "$1" in "$HEAD"*) return 0;; esac; return 1; }

  # Signal 1 — a current-head APPROVED review by a control-plane member who is NOT the author
  # (the N>=2 and N==1-sole!=author discharge). Latest review per author, APPROVED, commit_id == HEAD.
  NON_AUTHOR_APPROVAL_AT_HEAD=false
  CURRENT_APPROVERS="$(gh api --paginate "repos/$REPO/pulls/$PR/reviews?per_page=100" \
    --jq "group_by(.user.login) | map(max_by(.submitted_at))
          | map(select(.state == \"APPROVED\" and .commit_id == \"$HEAD\") | .user.login) | .[]")"
  while IFS= read -r u; do
    [ -z "$u" ] && continue
    [ "$u" = "$AUTHOR" ] && continue                          # self-approval never counts here (ADR 0175)
    st="$(gh api "orgs/$ORG/teams/control-plane/memberships/$u" --jq '.state' 2>/dev/null)"
    [ "$st" = "active" ] && { NON_AUTHOR_APPROVAL_AT_HEAD=true; break; }
  done <<<"$CURRENT_APPROVERS"

  # Signal 2 — a deliberate current-head self-approval MARKER by the sole owner (the ONLY N==1
  # sole-owner discharge). GitHub records no native self-approval, so the signal is a marker comment:
  # first line `control-plane-self-approval @ <sha>` — a DISTINCT token from the review-* markers, so
  # it can never leak a §CP PR into the auto-merge namespace (ADR 0111) — authored by the sole owner
  # and SHA-bound to the current head. The sole owner posts it to consciously self-approve their own
  # §CP PR; it is inert unless N==1 and they are the author (cp-cardinality ignores it otherwise).
  SELF_APPROVAL_AT_HEAD=false
  SELF_SHA="$(gh api --paginate "repos/$REPO/issues/$PR/comments?per_page=100" \
    --jq "[.[] | select(.user.login == \"$AUTHOR\")
               | select(.body | test(\"(?i)^\\\\s*\\\\**\\\\s*control-plane-self-approval\\\\b\"))]
          | last | .body // \"\"" \
    | grep -ioE 'control-plane-self-approval[[:space:]]*@?[[:space:]]*[0-9a-f]{7,40}' \
    | grep -ioE '[0-9a-f]{7,40}' | head -n1)"
  sha_binds_head "$SELF_SHA" && SELF_APPROVAL_AT_HEAD=true

  # The DETERMINISTIC decision — the whole ADR-0175 `case "$N"` branch lives in the tested pure core.
  # discharge → carry on to the machine gates; stop → STOP (fail closed). Pass a signal flag only when
  # that signal is present at head; cp-cardinality selects which signal the branch actually requires.
  if printf '%s\n' "$MEMBERS" | pipeline-cli cp-cardinality decide \
       --author "$AUTHOR" \
       $([ "$NON_AUTHOR_APPROVAL_AT_HEAD" = true ] && printf -- '--non-author-approval-at-head') \
       $([ "$SELF_APPROVAL_AT_HEAD" = true ] && printf -- '--self-approval-at-head'); then
    echo "§CP approval: discharged deterministically (ADR 0175) → carry on to machine gates"
  else
    echo "§CP approval: STOP (awaiting control-plane approval) — cardinality branch not satisfied (ADR 0175)"
  fi
  ```

  This is **only** the §CP unblock — it does not weaken any other guard. The SHA-bound gate verdict
  (Step 2/2b), CI-green (Step 3), the run-evidence bundle (Step 3.5), and single-merge-authority
  (ADR 0048) all still apply to a §CP PR exactly as to a non-§CP one; the cardinality discharge is an
  **additional** requirement, never a substitute. The two-person control is preserved exactly where it
  exists (`N >= 2`): GitHub blocks a member approving their **own** §CP PR, so a §CP change needs the
  OTHER team member (ADR 0135). Adding a second control-plane member automatically re-tightens the
  gate to that two-person control with no further edit — the branch keys on live cardinality (ADR 0175).
- Otherwise, note which **artifact classes are present** (skills, code, docs, or a mix) **and
  whether the diff is UI-affecting** (`has-ui`). Step 2 requires the matching gate's latest
  verdict = PASS for **each class present**: skills → `review-skill` PASS; code → `review-code`
  PASS; docs → `review-doc` PASS; a mixed PR needs a current-head PASS in **each** namespace
  present. **If the diff is UI-affecting (`has-ui`), a current-head `review-design` PASS is
  required *in addition*** — additive, alongside the class gate(s), never instead of one. Carry
  the class set **and the `has-ui` flag** into Step 2.

<a id="the-ui-affecting-detection-must-agree-with-the-reviewer"></a>
**The UI-affecting detection must AGREE with the reviewer, or the gate is unroutable.** ship-it
requires a `review-design` PASS *because the reviewer dispatched `review-design` on the same
diff*, AND *because the dispatched `review-design` run can actually reach a rendered surface to
verdict* — so the `UI_RE` probe above (`^apps/web/src/` — a changed path under the rendered
frontend) **must be the same rule** the reviewer agent uses to decide whether to run
`review-design` **and** the rule `review-design`'s own Step 0 off-ramp uses to decide it has a
surface to gate. This is the same **required-gate == dispatched-gate == satisfiable-gate**
invariant that binds the has-code probe to review-code's scope: if ship-it required `review-design`
on a diff the reviewer never routed to it — or on one the dispatched `review-design` run then
off-ramps as non-UI without emitting a marker — that PR would demand a `review-design: PASS` **no
gate ever produces** → every such PR **deadlocks** (`unverified — no review-design PASS`). That
second gap is exactly #2470: the earlier `UI_RE='^apps/web/src/|\.tsx$|\.css$'` was a **superset**
of review-design's `^apps/web/src/` off-ramp, so a `.tsx`/`.css` outside `apps/web/src` was
required-but-unroutable — now the one live `UI_RE` is `^apps/web/src/` and all three sides
(require, dispatch, off-ramp) resolve it. Lockstep here is **not two hand-synced copies that drift as
each side's checkout ages** — that staleness was the enforcement hole (#2341: a shipper/reviewer on
a snapshot predating the review-design merge silently omitted the gate; PR #2333 merged
un-design-reviewed). Both sides instead resolve `UI_RE` from **one live source — `UI_RE=` in
`ship-it/SKILL.md` on `origin/main`**, read via `?ref=main` at run time (the `#981` idiom the §CP
`CONTROL_PLANE_RE`/`GUARD_ADR_RE` already use): ship-it re-resolves it in the probe above,
`reviewer.md` re-resolves the **same line from the same ref** before deciding to dispatch
`review-design`, and `review-design`'s Step 0 off-ramp re-resolves the **same line** before
deciding it has a rendered surface to gate (#2470). All three fail closed to
*require*/`dispatch`/*proceed* on the gate if that line is unreadable — never to skip it. So they
agree by construction, not by manual sync: change the one live `UI_RE` (e.g. a new app worker →
`apps/**/src`) and every side tracks it on its next run.

**The docs class must equal `review-doc`'s verification scope, or the gate it demands is
unreachable.** ship-it requires a class's gate PASS *because that gate runs on that class* —
so the docs probe may only class as docs a path a `review-doc` PASS can actually gate. The
`.md$` match is therefore **scoped, not over-matching**: it runs only after `grep -Ev
'^(claude-plugins|apps|packages|\.glossary|infra)/'` carves out the path-classes whose `.md` is **not** review-doc's
(this is the §DOC contract — cite it, don't re-derive the carve-out here):

- **`claude-plugins/kampus-pipeline/skills/**`** — a skill `.md` is `review-skill`-gated (ADR 0073). Classing it docs would
  demand a `review-doc` PASS that never comes (the original #358 deadlock, closed by the
  dedicated gate).
- **`apps/**` / `packages/**` / `infra/**`** — a package/app-internal `*.md` (a README, CHANGELOG) ships
  with its code artifact and is **`review-code`'s** scope: `review-code` reviews the whole
  `apps/**`/`packages/**`/`infra/**` tree, README included, and `review-doc` explicitly disclaims that tree
  (its Step 0 routes the `apps/**` workers — `apps/web`, … — `packages/**`, and the `infra/**`
  standalone stacks (ADR 0057) to `review-code`). Classing such a `.md` docs demanded a `review-doc` PASS no gate ever produces —
  review-code gates and PASSes the tree, but no doc gate runs on it — so a clean, fully-gated
  product PR that merely *includes* a package README **deadlocked** (`unverified — no review-doc
  PASS`), the exact defect on PR #644 (#542/#650), reachable again for `infra/**` standalone stacks
  (ADR 0057) until `infra` was added to the carve-out (#1987). Carving the code roots out makes the
  present class always have a reachable gate.
- **`.glossary/**`** — the domain-vocabulary surface (`.glossary/TERMS.md`) is gated by
  `review-code` Step 3c, which **reads + enforces** the glossary contract (a new code surface MUST
  touch `TERMS.md` — the #912 freshness gate). The gate that owns the glossary is therefore
  `review-code`, so a `.glossary/**` touch rides the `review-code` PASS — the **same** precedent as
  the `apps`/`packages` README. Were it left in the doc class, #912's mandatory `.glossary/TERMS.md`
  touch on every new-surface **code** PR would make that PR mixed code+doc and demand a `review-doc`
  PASS the pipeline never routes — the exact #919 deadlock (review-code PASSed, ship-it refused
  `unverified — no review-doc PASS`). It is **non-blocking** — a knowledge surface like
  `.decisions`/`.patterns`, **not** §CP — so a new-surface code PR still autoships with no
  human-merge tax.

**The has-code probe and this docs-exclusion name the same roots — they MUST agree.** The
docs probe carves out `^(claude-plugins|apps|packages|\.glossary|infra)/` and the has-code probe is `^(apps|packages|\.glossary|infra)/`:
both span the **full `apps/**` tree** (every app worker — `apps/web`, and any future app), not
just `apps/web`, **and both name `.glossary/**` and `infra/**`**. That agreement is the invariant — if the two
diverged (e.g. has-code stayed `apps/web` while docs excluded all `apps/**`, or the docs-exclusion
named `infra/**` while has-code did not), an `apps/<other>/**` or `infra/<stack>/**`
path — code `.ts` **or** `README.md` — would class as **neither** has-code (the narrow probe misses
it) **nor** has-docs (the docs exclusion drops it), and ship-it would demand **no** gate at all and
merge it **ungated**. Widening has-code to `apps/**` closes that hole for app workers (#663), and
adding `infra/**` in lockstep closes it for standalone stacks (ADR 0057; #1987): every `apps/<app>` and
`infra/<stack>` path now classes has-code and rides its `review-code` PASS, exactly as `apps/web` always has.

`.glossary/**` is carved out of the docs probe (it is `review-code`'s scope, not `review-doc`'s —
Step 3c reads + enforces it) **and** named by the has-code probe, in lockstep — so a `.glossary/**`
touch classes **has-code** and rides the `review-code` PASS, never falling into the #663 neither-class
hole. This holds for both shapes the glossary PR takes: the #912-mandated touch riding a new-surface
code change (already has-code from the code files), and a pathological glossary-**only** PR (now
has-code from `.glossary/**` alone) — both demand exactly the `review-code` PASS that the gate owning
the glossary produces (`review-code`'s Step 0 verifies a glossary-only PR; it never off-ramps it). The
class label moves docs→code; no path goes ungated, and `.glossary/**` is **never** §CP/blocking, so a
new-surface code PR still autoships with no human-merge tax.

So `.decisions/**`/`.patterns/**` always class docs, and a prose `*.md` classes docs **only when
it lives outside the code roots, `claude-plugins/kampus-pipeline/skills/**`, and the control plane** — i.e. exactly the surface
`review-doc` verifies. This keeps the docs class and the doc gate consistent: a present docs class
implies a `review-doc` PASS is *obtainable*, never a phantom requirement. The control-plane check
remains the only **exact** probe and is unchanged; this carve-out narrows **only** the docs class,
weakening no other guard — the §CP approval gate, SHA-binding, and the green-CI requirement all
still hold, and a `packages/**`-internal `.md` simply rides the `review-code` PASS its tree already
needs.

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

If there **is** a linked issue (a closing keyword + `#N`), honor it as today regardless of
class — resolve it; the queue's async squash-merge (Step 4's `--auto` enqueue) auto-closes it
via `Fixes #<ISSUE>` when the merge lands (ADR 0132).

**Intentional partial-split — an explicit non-closing `Part of #N`.** A closing keyword is not
the only legitimate way a code/skills PR references its issue. When the body carries **no**
closing keyword but **does** carry an explicit non-closing **`Part of #N`** reference
(case-insensitive, naming a real open issue number), this is an *intentional* non-closing
state, the **opposite** of a forgotten seam: a backend-then-frontend partial split
deliberately advances one half while a sibling lane finishes the other, so the linked issue is
kept **open on purpose** until that sibling closes it. Recognize it as a **valid linked
reference that merges without auto-closing**: pin it for the report and **leave `ISSUE`
unset**, so Step 4's squash neither expects nor performs an auto-close and Step 5's
explicit-close fallback never fires — `#N` stays open for the sibling lane.

```bash
PART_OF=<N>   # the partial-split issue this PR advances but deliberately does NOT close; ISSUE stays unset
```

Do **not** refuse this as `no linked issue`: every actual merge-safety guard is unaffected
(Step 0's control-plane class, Step 2/2b's current-head PASS, Step 3's green CI, Step 3.5's
run-evidence all still hold) — only the missing-closing-keyword check is relaxed, and **only**
for this one explicit marker. This is a **parallel** allowance to the doc/vocab-surface-only
carve-out below
(ADR [0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)),
not the same one: the doc/vocab-surface-only path is *issueless* (nothing to close); a partial
split *names an issue it intentionally keeps open*. The `Part of #N` marker is a non-closing mention by construction —
GitHub never populates `closingIssuesReferences` from it (only a closing keyword does;
[gh-issue-intake-formats.md §9](../gh-issue-intake-formats.md)) — which is exactly why the merge
leaves `#N` open.

If there is **no** linked issue, the rule is **class-aware** — reuse the artifact classes
Step 0 already computed (do **not** re-derive them; ADR
[0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)):

The carve-out turns on **doc/vocab-surface-only**, a wider set than Step 0's `docs` class.
The **doc/vocab surfaces** are `.decisions/**`, `.patterns/**`, `.glossary/**`, and prose
`*.md` — all of which legitimately have **no** tracked issue. `.glossary/**` is a doc/vocab
surface here even though Step 0 classes it **has-code** (the #919 reclassification: the glossary
is owned by `review-code` Step 3c, not `review-doc`). That has-code label is about *which gate
verifies the glossary*, not about whether a glossary touch needs a `Fixes #N` — so the issueless
allowance keys on the **surface**, not the gate class. A PR is **doc/vocab-surface-only** when
**every** changed path is one of those four surfaces (no `apps/**`/`packages/**`/`infra/**` code,
no `claude-plugins/**` skills source).

- **A real code or skills class is present** — a changed path under `apps/**`, `packages/**`,
  `infra/**`, or `claude-plugins/**` (skills source), i.e. the PR is **not**
  doc/vocab-surface-only — **with no issue reference at all** — neither a closing keyword **nor**
  the explicit `Part of #N` partial-split marker above → stop and report `no linked issue`. In
  this pipeline `write-code` always writes `Fixes #N` (or, for a deliberate partial split,
  `Part of #N`), so a code PR that names **no** issue at all is a broken seam, not a normal
  state — it has nothing to auto-close on merge and would leave dangling work. (Distinct from the
  *linked-but-didn't-auto-close* case Step 5 handles: there the seam fired but GitHub didn't,
  which is recoverable; here no issue is named on a code PR, an anomaly worth stopping on. Also
  distinct from the partial-split above, where `Part of #N` names the issue **on purpose** to
  keep it open — that merges, this refuses.)
- **Doc/vocab-surface-only** (every changed path is `.decisions/**`, `.patterns/**`,
  `.glossary/**`, or prose `*.md` — **no** `apps/**`/`packages/**`/`infra/**` code and **no**
  `claude-plugins/**` skills source) → a missing `Fixes #N` is a **legitimate state, not a broken
  seam**. A conversation-authored ADR/doc records a settled choice that was never tracked work, so
  there is nothing for a `Fixes #N` to close (ADR 0075). The canonical shape is a
  conversation-authored ADR that co-locates its own `.glossary/**` term rename in the same PR
  (the `adr` skill's vocabulary-impact step directs this) — a PR touching `.decisions/**` **and**
  `.glossary/**` is doc/vocab-surface-only and ships issueless, even though `.glossary/**` makes
  it has-code per Step 0/#919. Skip the auto-close expectation, leave `ISSUE` unset, and
  **proceed to the gate check** — the PR ships on its gate PASS(es) alone (Step 2). Emit **no**
  `no linked issue` refusal; it is not an anomaly. This relaxes **only** the missing-link guard:
  Step 0's §CP approval gate and Step 2's required **current-head PASS in each class present**
  are untouched — the glossary-riding class still requires its `review-code: PASS` and
  `.decisions/**`/`.patterns/**`/prose its `review-doc: PASS`.

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

- code:   `^\s*\**\s*review-code:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- doc:    `^\s*\**\s*review-doc:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- skill:  `^\s*\**\s*review-skill:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
- design: `^\s*\**\s*review-design:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`

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
comments_file=$(mktemp)
gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$comments_file"

# distinct logins that posted any review-code/review-doc/review-skill/review-design marker
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill|design):\\s*(PASS|FAIL)"; "i"))
    | .user.login] | unique | .[]' "$comments_file")

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
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' "$comments_file"

# latest review-doc marker comment (doc namespace) — author-gated, anchored, never matches review-code/review-skill
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' "$comments_file"

# latest review-skill marker comment (skill namespace) — author-gated, anchored, never matches review-code/review-doc
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-skill:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-skill:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' "$comments_file"

# latest review-design marker comment (design namespace) — author-gated, anchored, never matches review-code/review-doc/review-skill
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-design:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-design:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' "$comments_file"
```

Now resolve **per namespace**, latest-wins by timestamp:

- **review-code namespace** — the verdict is the **newest of {latest decisive review, latest
  review-code marker comment}** by timestamp (review `submitted_at` vs comment `created_at`).
  An `APPROVED` review or a `review-code: PASS … merge-ready` marker is PASS; a
  `CHANGES_REQUESTED` review or a `review-code: FAIL` marker is FAIL. The verdict's bound SHA
  is the marker's `@ <sha>` (or, for a native review, its `commit_id`). (The native
  approving-review path stays; it interleaves only with the review-code markers, never with
  review-doc.) A **§CP** code PR's verdict is likewise the SHA-less-first-line advisory
  (`review-code: advisory — blocking-set PR …`) — §6.6/ADR 0151 converges **all four** gates on
  the one advisory form, so a §CP review-code advisory is resolved from the body's canonical
  `Reviewed-head` line via the
  **[§CP advisory resolution](#step-2cp--cp-advisory-namespace-resolution-adr-01350151)** below
  (ADR 0111/0151), gated on Step 0's control-plane approval — **never** from a bindable first-line
  marker (that would drop the §CP verdict into the auto-merge namespace, the ADR 0111 hazard). This
  is the written resolution path a canonical review-code §CP advisory previously lacked (#2329).
- **review-doc namespace** — the verdict is the **latest `review-doc` marker comment** by
  `created_at`; its bound SHA is the marker's `@ <sha>`. `review-doc: PASS … merge-ready` is
  PASS; `review-doc: FAIL … changes-requested` is FAIL. (review-doc lands no native review —
  it is comment-only, ADR 0058 — so there is no review path to fold in, and no review-vs-comment
  comparison to make.) A §CP doc PR's verdict is likewise the SHA-less-first-line advisory
  (`review-doc: advisory — blocking-set PR …`), resolved for a §CP PR from the body's
  `Reviewed-head` line via the same
  **[§CP advisory resolution](#step-2cp--cp-advisory-namespace-resolution-adr-01350151)** below
  (ADR 0111/0151) — never from a bindable first-line marker.
- **review-skill namespace** — the verdict is the **latest `review-skill` marker comment** by
  `created_at`; its bound SHA is the marker's `@ <sha>`. `review-skill: PASS … merge-ready` is
  PASS; `review-skill: FAIL … changes-requested` is FAIL. (review-skill is comment-only too,
  ADR 0058 — same single-record-type resolution as review-doc.) For a **non-§CP** skill PR an
  **advisory** line (`review-skill: advisory — blocking-set PR …`) carries no first-line `@ <sha>`
  and is **not** a PASS — it never enters the machine-PASS namespace here. But a §CP skill PR's
  *only* verdict IS that advisory — ADR 0111 makes it SHA-less **in the first line by design**, and
  binds the reviewed head **in the body** — so for a §CP PR ship-it resolves the advisory namespace
  from the body's canonical `Reviewed-head` line via the
  **[§CP advisory resolution](#step-2cp--cp-advisory-namespace-resolution-adr-01350151)** below,
  gated on Step 0's control-plane approval (ADR 0135/0151). That §CP path is the **only** way a §CP
  advisory resolves — a §CP PR is **never** required to (nor satisfied by) a bindable first-line
  `review-skill: PASS @ <sha>` marker (that would drop it into the auto-merge namespace — the ADR 0111
  hazard #2022's forge-workaround must not take).
- **review-design namespace** — the verdict is the **latest `review-design` marker comment** by
  `created_at`; its bound SHA is the marker's `@ <sha>`. `review-design: PASS … merge-ready` is
  PASS; `review-design: FAIL … changes-requested` is FAIL. (review-design is comment-only, ADR
  0058 — same single-record-type resolution as review-doc/review-skill; a newer FAIL in this
  namespace vetoes an older PASS, latest-wins, exactly like the other gates.) This namespace is
  resolved **and required only when the diff is UI-affecting** (Step 0's `has-ui`) — it is the
  additive UI-quality gate, so a non-UI PR neither resolves nor needs it. On the rare §CP UI PR,
  a `review-design` **advisory** resolves via the same
  **[§CP advisory resolution](#step-2cp--cp-advisory-namespace-resolution-adr-01350151)** below
  as review-skill/review-doc (comment-only, body-bound `Reviewed-head`), never a bindable
  first-line PASS.

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

<a id="step-2cp--cp-advisory-namespace-resolution-adr-01350151"></a>
### Step 2.§CP — resolve a §CP advisory namespace from the body's `Reviewed-head` line (ADR 0135/0151)

**This step runs only for a PR Step 0 classified §CP whose approval gate passed** (a current-head
`@kamp-us/control-plane` team approval is present — else Step 0 already STOPPED at `awaiting
control-plane approval`, and you never reach here). A §CP `review-skill` / `review-doc` PR's *only*
verdict is the **SHA-less-first-line advisory** (ADR 0111): its first line carries no `@ <sha>`, so
the Step-2 first-line matcher above resolves that namespace's `sha` to `null` and Step 2b would
refuse it as a legacy SHA-less marker. That refusal is **correct for a non-§CP PR** but is the
#1932/#2022 collision for a §CP one — the advisory is the *intended* §CP verdict, and its reviewed
head is bound **in the body**, not the first line. So for the §CP advisory namespaces, resolve the
reviewed head from the body's **canonical `Reviewed-head: @ <sha>` line** (mandated in
`gh-issue-intake-formats.md` §6.6 and emitted by the review-skill/review-doc advisory templates,
ADR 0151) instead of the first-line `@ <sha>`.

This is **deterministic** — the outcome is a pure function of the PR's state (body `Reviewed-head`
SHA + per-check PASS + approval@head + CI), never of which shipper instance reads it — which is the
whole point (#2022): identical §CP PRs must enqueue-or-refuse identically. It is **§CP-only** and
does **not** widen the reviewer marker contract: the reviewer still emits the SHA-less advisory
(ADR 0111 intact); ship-it reads the SHA from the body, exactly as ADR 0111's delegated
control-plane merge actor does. **Never** treat a §CP advisory as satisfied via a bindable
first-line `review-skill: PASS @ <sha>` marker (that drops it into the auto-merge namespace — the
ADR 0053/0065/0111 hazard; the hand-posted-marker forge on #2005 is the workaround this replaces and
forbids).

For each §CP namespace whose latest verdict is a **current-head advisory** (first line matches
`^\s*\**\s*review-(code|skill|doc|design):\s*advisory\b`), resolve it as an **enqueue-eligible
current-head PASS-equivalent** iff **all three** hold, else **refuse deterministically with the
named reason**. `review-code` is in this set: a §CP code PR's approved verdict is the same SHA-less
advisory (§6.6/ADR 0151 converges **all four** gates on one advisory form), so its body
`Reviewed-head` line resolves the enqueue exactly like the doc/skill/design namespaces — without it,
a canonical review-code §CP advisory had no written resolution path and read as `sha: null` → refused
on a legitimately-approved PR (#2329):

```bash
# $ADV_BODY = the latest §CP advisory comment body for this namespace (review-code/skill/doc/design),
# author-gated (write+, ADR 0055) and latest-wins exactly like the markers above.
# (a) body's canonical Reviewed-head SHA (ADR 0151 §6.6) must prefix-match the PR's current head.
#     Anchored to the `Reviewed-head:` line — a DISTINCT token from the first-line advisory marker,
#     so this never mistakes a first-line marker for the body binding, and the advisory stays out of
#     the PASS namespace. Optional `@`, 7–40 hex, ADR 0058 prefix-match either side.
BODY_SHA="$(printf '%s' "$ADV_BODY" | grep -ioE '^[[:space:]]*Reviewed-head:[[:space:]]*@?[[:space:]]*[0-9a-f]{7,40}' \
              | grep -ioE '[0-9a-f]{7,40}' | head -n1)"
is_current "$BODY_SHA" || { echo "unverified (§CP advisory reviewed-head stale — body @ ${BODY_SHA:-none} ≠ current head) → refuse"; }
# (b) every checkbox in the body is PASS — a clean recorded verdict, no [FAIL] anywhere.
if printf '%s' "$ADV_BODY" | grep -qiE '^\s*[-*]?\s*\[[[:space:]]*FAIL[[:space:]]*\]'; then
  echo "unverified (§CP advisory not all-PASS — a body checkbox is [FAIL]) → refuse"
fi
# (c) Step 0's current-head @kamp-us/control-plane approval — already asserted before reaching here.
#     All three ⇒ this §CP namespace is a current-head PASS-equivalent for the class-gate below.
```

A §CP namespace with **no** advisory comment at all (nor any PASS/FAIL marker) is still
`unverified (no review-<code|skill|doc> PASS)` — the resolution needs a current-head advisory to read.
A §CP namespace whose latest verdict is a `review-<code|skill|doc>: FAIL` marker is a **FAIL** (the
reviewer found a miss), refused exactly as a non-§CP FAIL — the §CP advisory path is entered only
when the latest verdict is an *advisory*, never to mask a FAIL.

Then gate the merge on the classes present (Step 0):

1. For **each class present**, its namespace must have a latest verdict, it must be **bound to
   the current head** (Step 2b, or Step 2.§CP for a §CP advisory namespace), and it must be PASS
   (or, for a §CP advisory namespace, the Step 2.§CP PASS-equivalent).
   - code present but the review-code namespace is empty → `unverified (no review-code PASS)`.
   - docs present but the review-doc namespace is empty → `unverified (no review-doc PASS)`.
   - skills present but the review-skill namespace is empty → `unverified (no review-skill PASS)`.
   - **UI-affecting (`has-ui`) but the review-design namespace is empty → `awaiting review-design
     (no review-design PASS)` → do not ship.** This is **additive**: it holds *on top of* the
     PR's artifact-class gate(s), so a UI PR under `apps/web/src` (has-code) needs **both** a
     current-head `review-code` PASS **and** a current-head `review-design` PASS.
   - a verdict present but not bound to the current head → `unverified (verdict not bound to
     current head)` → refuse. (For a §CP advisory namespace, "bound to current head" is the body's
     `Reviewed-head` SHA per Step 2.§CP, not the absent first-line `@ <sha>`.)
   - a mixed PR needs **each** present namespace resolved to a current-head PASS (e.g. a
     skill+code PR needs both `review-skill` and `review-code`); a UI-affecting PR additionally
     needs a current-head `review-design` PASS alongside those (e.g. a UI code PR needs
     `review-code` **and** `review-design`).
2. If **any** required namespace's current-head verdict is **FAIL** → **do not merge.** The PR
   has unaddressed failures as its *current* state, even if an older PASS exists. Report
   `latest verdict is FAIL (<which gate>)` and stop; the fix round-trip is `write-code`'s
   (code) / the doc author's job, not yours.
3. If **every** required namespace's current-head verdict is PASS → guard 1 cleared, proceed to
   Step 3.

The polarity of the **newest current-head** event in each namespace is the only thing that
decides — an old PASS behind a newer FAIL never ships, an old FAIL behind a newer PASS does not
block, and a PASS bound to a *stale* head never ships at all.

**This per-present-class requirement iterates over EVERY class Step 0 found — never just one —
and, when the diff is UI-affecting, folds in the additive `review-design` gate.** The merge is
gated on the **conjunction** across all present namespaces plus `review-design` when `has-ui`: a
mixed code+docs PR clears guard 1 **only** when the review-code namespace AND the review-doc
namespace each resolve to a current-head PASS; a UI code PR clears it **only** when the
review-code namespace AND the review-design namespace each do; a single namespace's PASS while
another *required* namespace (including `review-design` on a UI PR) is empty/stale/FAIL
**refuses** (`unverified (no review-doc PASS)`, `awaiting review-design (no review-design PASS)`,
etc.). This is the **fail-closed
late catch** — the safety net, deliberately preserved unchanged. It is **not** meant to be the
*first* place a second required namespace is discovered: the routing review gate upstream now
resolves **every** present namespace in one pass (the *routing-completeness rule* in
`review-code`/`review-doc`/`review-skill` Step 0 — run the matching gate for every non-blocking
class the diff spans, not just one), so a well-routed mixed PR arrives here with a current-head
PASS already standing in each namespace and merges without a bounce-back (#1460 / the PR #1442
incident — a `review-code: PASS` with no `review-doc`, correctly refused here for the empty docs
namespace, but only after a wasted review→ship round-trip the upstream routing now prevents).
ship-it's refusal stays exactly as above — it remains the last line of defense for a genuinely
missing or stale namespace, never weakened to route around an upstream routing miss.

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

## Step 3 — Confirm the *gating* checks are green (one read, then a bounded CI-settle poll)

You confirm checks. Read the current check state **once** to classify it, then branch. If that
first read is already decisive — every gating check green, or a gating check red, or a dropped
trigger — the outcome is settled with no wait. If instead some gating check is still **pending**,
you do **not** report-and-park hoping a caller re-invokes you: that delegation was the silent-death
hole of [#1928](https://github.com/kamp-us/phoenix/issues/1928) (a shipper that parked on a poll
and died left the PR green-but-not-enqueued with **no** FAIL and **no** outcome comment). You run a
**bounded, in-process CI-settle poll** ([§The bounded CI-settle poll](#the-bounded-ci-settle-poll--never-a-silent-park-1928))
that always terminates in one of two PR-visible outcomes — the enqueue, or an explicit refusal
comment — never a silent park. The human table and exit code can't cleanly separate red from
pending, and neither tells a *gating* check from an *informational* one — so read the per-check
**names and states** and classify by name, not by a bare bucket count:

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
heal-ci) — the `Deploy` workflow's preview-deploy-infra checks: `deploy (web)` (the `pr-<n>`
preview-stage deploy) and `cleanup (web, …)` (the `Deploy` workflow's preview-stage
`alchemy destroy` teardown leg). A preview-deploy infra flake (e.g. `Secret probe
returned 502`) or a preview-teardown race (e.g. a close→reopen reds `cleanup`) is orthogonal
to whether the PR is correct and tested. Match these two names exactly — only the named
preview-deploy/teardown checks are informational; every other red, including any
run-evidence (lint/format/typecheck, unit/integration/e2e) check, stays gating — see ADR
[0061](https://github.com/kamp-us/phoenix/blob/main/.decisions/0061-ship-it-gating-check-set.md).

An **empty** check set is ambiguous and must not be read as green on its face: it is either
"CI ran and every check passed" or "no run ever fired for this head." Disambiguate it against
the workflow runs GitHub actually recorded for the head SHA — **both reads fail safe toward
"do *not* nudge"** (the Step-3z remedy close→reopens a live PR; never do that on a guessed
absence):

```bash
HEAD_SHA=$(gh api repos/$REPO/pulls/$PR --jq '.head.sha')
# (a) Does this repo run Actions at all? A CI-less / foreign repo's empty check set is genuine,
#     not a dropped trigger — it degrades to the PASS-only path (Step 3.5 portability), no nudge.
NWF=$(gh api "repos/$REPO/actions/workflows?per_page=100" --jq '.workflows | length' 2>/dev/null)
# (b) Workflow runs recorded for THIS exact head SHA (the same head_sha bind Step 3.5 uses).
NRUNS=$(gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100" \
  --jq '.workflow_runs | length' 2>/dev/null)
# An empty capture = the lookup itself failed (network/auth/rate-limit), NOT a confirmed zero —
# never nudge on an unconfirmed absence: assume "runs exist" / "no Actions", fall through, and
# let the Step 3.5 backstop guard the merge.
[ -z "$NRUNS" ] && NRUNS=1
[ -z "$NWF" ]   && NWF=0
```

Classify in this order (`skipping`/`cancel` are non-blocking — neither a failure nor an
in-flight wait):

1. **Any *gating* check red** (a `fail` whose name is not known-informational) → do **not**
   merge. Route it to the self-heal lane: invoke [`/heal-ci`](../heal-ci/SKILL.md) with this
   PR/run, then report the result (e.g. `routed to heal-ci`). `heal-ci` decides
   flake-vs-defect; you only refuse on a gating red and hand off — you still do not merge.
2. **Else, any check pending** (no gating red, some unfinished) → **enter the bounded CI-settle
   poll** ([§below](#the-bounded-ci-settle-poll--never-a-silent-park-1928)). Do **not** report
   `checks pending` and park: that stop-path delegated resumption to a caller that may never fire,
   and because a decline is a *successful* outcome it left the PR green-but-unenqueued with **no**
   FAIL and **no** outcome comment — the silent stall of #1928. The bounded poll re-reads the checks
   on a fixed budget and **always** terminates in exactly one of two PR-visible outcomes: it reaches
   the enqueue (fall through to Step 3.5 → Step 4) the moment the gating suite goes green, or — if
   the budget is exhausted with a gating check still pending — it posts an explicit
   `refused — CI still pending after <budget>` outcome comment on the PR and stops.
3. **Else, the repo runs Actions (`NWF ≥ 1`) but the head SHA has zero workflow runs
   (`NRUNS == 0`)** → the **dropped-trigger state** (Step 3z). This is **not** green: an empty
   check set with *no runs behind it* is "CI never fired," not "CI ran and passed." Do **not**
   fall through to Step 4 — go to [Step 3z](#step-3z--the-dropped-trigger-state-zero-workflow-runs--bounded-nudge),
   which surfaces the distinct reason and performs the bounded close→reopen nudge.
4. **Else proceed to Step 4** — every gating check is green. If a *known-informational*
   check is red, it does not block: note it in the ledger (`informational check red (deploy
   (web)) — not gating`, or `informational check red (cleanup (web, …)) — not gating`) and
   continue. Step 3.5 remains the SHA-bound backstop that the gating suite actually passed
   for this commit.

The gating set is, by construction, the suite the run-evidence bundle attests SHA-bound in
Step 3.5 (lint / format / typecheck, unit tests, validate skill frontmatter, integration
when it runs) — Step 3 is the cheap early read, Step 3.5 is the authority; if the two ever
disagree, Step 3.5 wins.

### The bounded CI-settle poll — never a silent park (#1928)

Branch 2 (gating checks still pending) does **not** hand resumption to "the caller re-invokes you
after CI settles." That delegation was a **liveness hole**: nothing guaranteed the re-invocation
ever fired, and because a decline is a *successful* outcome (no FAIL, no error), a shipper that
parked on a background poll and died left the PR **green-but-not-enqueued with zero signal** — no
`added_to_merge_queue` event, no outcome comment, invisible until a human re-polled merge state
([#1928](https://github.com/kamp-us/phoenix/issues/1928), observed on PR #1916). The remedy is a
**bounded, in-process** poll the shipper runs to completion itself: it either reaches the enqueue
or emits a durable, PR-visible refusal — **every** exit from the pending-wait is observable.

**This deliberately amends Step 3's former "one read, no polling" invariant, narrowly.** The old
invariant existed to stop the atomic stage from blocking on an *unbounded* synchronous wait; the
replacement keeps that intent — the poll is **bounded** by a fixed budget, and each pass emits
progress so a no-progress watchdog never fires — while closing the silent-death hole. It does
**not** conflict with ADR [0132](https://github.com/kamp-us/phoenix/blob/main/.decisions/0132-merge-queue-for-base-freshness.md)'s
async merge-queue model: 0132 makes the **final merge** async (the queue merges the batch
server-side *after* the enqueue), which is untouched. This poll spans only the window *before* the
enqueue — waiting for the PR's own gating checks to settle so the enqueue can happen at all; once
enqueued, the merge remains the queue's async job.

`ci_settle_wait` re-runs the same Step-3 classification on a loop until the budget runs out. The
budget is a fixed, tunable ceiling (default ~10 min at a 30s cadence) — long enough to outlast a
normal CI settle, bounded so a stuck check can never wait forever. It is entered **only from
branch 2**, i.e. with the pending set already non-empty (so runs are known to have fired) — which
is why a later-empty pending set inside the loop is a genuine green, not the dropped-trigger
false-green Step 3z guards (that state is branch 3, never reached from here):

```bash
SETTLE_BUDGET_SECS="${SHIP_IT_SETTLE_BUDGET_SECS:-600}"    # total in-process wait ceiling — BOUNDED, never unbounded
SETTLE_INTERVAL_SECS="${SHIP_IT_SETTLE_INTERVAL_SECS:-30}" # cadence; each pass emits progress so a no-progress watchdog never fires
ci_settle_wait() {   # returns 0=settled-green→enqueue · 1=refused (budget-exhausted OR head moved mid-settle; comment posted) · 2=gating red mid-wait→heal-ci
  local waited=0 bucket name red pending headnow
  while :; do
    red=""; pending=""
    while IFS=$'\t' read -r bucket name; do
      case "$bucket" in
        # same known-informational carve-out as Step 3: a red preview-deploy/teardown check never gates
        fail)    case "$name" in "deploy (web)"|"cleanup (web,"*) ;; *) red="$red $name" ;; esac ;;
        pending) pending="$pending $name" ;;
      esac
    done < <(gh pr checks "$PR" --json name,state,bucket --jq '.[] | "\(.bucket)\t\(.name)"')
    if [ -n "$red" ]; then
      echo "gating check went red during settle-wait ($red) — routing to heal-ci"; return 2
    fi
    if [ -z "$pending" ]; then
      # TOCTOU guard (secondary #1928 note): the in-process poll widens the window between Step 2/2b's
      # SHA-bound verdict check (bound to $CURRENT_HEAD) and the enqueue. Unlike the old park→fresh-reinvoke
      # (which re-ran Step 2b on resume), this in-process resume enters at Step 3.5 and does NOT re-run
      # Step 2b — so a head-move during the settle would enqueue a head whose verdict/run-evidence predate
      # it. Re-confirm the head is still the verified one before returning green; if it moved, refuse (same
      # durable-comment/stop disposition as budget-exhaustion) so a re-dispatch re-runs Step 2b on the moved head.
      headnow="$(gh api repos/$REPO/pulls/$PR --jq '.head.sha')"
      if [ -n "$headnow" ] && [ "$headnow" != "$CURRENT_HEAD" ]; then
        gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: refused — head moved during CI-settle (verified ${CURRENT_HEAD}, now ${headnow}) — **not enqueued**. The SHA-bound verdict and run-evidence (Step 2/2b) predate this head; re-dispatch ship-it to re-verify the moved head — idempotent, a re-ship on a re-verified head enqueues cleanly (#1928)." >/dev/null
        echo "refused — head moved during settle-wait (${CURRENT_HEAD} → ${headnow}); Step 2b must re-run — not enqueued"; return 1
      fi
      echo "gating checks settled green after ${waited}s — proceeding to Step 3.5 → enqueue"; return 0
    fi
    if [ "$waited" -ge "$SETTLE_BUDGET_SECS" ]; then
      # Budget exhausted, still pending → the ONE required durable signal: an explicit PR-visible refusal.
      # A plain outcome note, NOT a review-* verdict marker — so it never blocks a later idempotent re-ship.
      gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: refused — CI still pending after ${SETTLE_BUDGET_SECS}s (gating checks unfinished:${pending}) — **not enqueued**. This head is not yet merge-ready; re-dispatch ship-it once CI settles — idempotent, a re-ship on the now-green head enqueues cleanly (#1928)." >/dev/null
      echo "refused — CI still pending after ${SETTLE_BUDGET_SECS}s (PR outcome comment posted) — not enqueued"; return 1
    fi
    echo "checks still pending after ${waited}s (${pending# }) — re-reading in ${SETTLE_INTERVAL_SECS}s (budget ${SETTLE_BUDGET_SECS}s)"
    sleep "$SETTLE_INTERVAL_SECS"; waited=$((waited + SETTLE_INTERVAL_SECS))
  done
}

ci_settle_wait; SETTLE_RC=$?
case "$SETTLE_RC" in
  0) : ;;         # settled green → fall through to Step 3.5 → Step 4 (enqueue)
  2)              # gating red mid-wait → route to /heal-ci (Step 3 branch 1's disposition), then STOP — never enqueue.
     # This arm MUST terminate the ship, exactly like `1)`: a check that goes red DURING the poll is a
     # gating red, and Step 3 branch 1's disposition is "do NOT merge; invoke /heal-ci and report." Invoke
     # /heal-ci for this PR (the same agent action Step 3 branch 1 takes), then exit — falling through here
     # would enqueue a red PR, the exact merge-safety hole this arm exists to close (#1928).
     echo "routed to heal-ci — gating check went red mid-settle for PR #$PR; not enqueued"; exit 0 ;;
  1) exit 0 ;;    # refused (budget-exhausted, or head moved mid-settle) — durable outcome comment posted; a successful decline, no longer silent (#1928)
esac
```

The three returns are the **whole guarantee**: `0` reaches the enqueue, `2` routes a mid-wait red
to `heal-ci` (branch 1's disposition) **and stops the ship** — it never falls through to Step 3.5 →
Step 4 — and `1` posts the durable refusal and stops. Both non-zero returns `exit` the shipper; only
`0` proceeds to enqueue. There is **no fourth path** where the shipper leaves the pending-wait without
either enqueuing or landing a PR-visible outcome — the silent park of #1928 is structurally
unreachable, and a mid-wait gating-red can never slip through to the merge queue.

**Idempotency is preserved.** The refusal comment is a plain outcome note, not a `review-*` verdict
marker and not a merge blocker, so a later re-dispatch on the now-green head clears every guard and
enqueues cleanly — no double-enqueue, no false "already shipped." Re-running `ci_settle_wait` on a
green head returns `0` on its first read (zero waiting) and proceeds straight to the enqueue. As
defense-in-depth, an orchestrator-side stall detector (out of this skill's scope) may still flag any
`review-*`-PASS + CI-green + OPEN PR with no queue entry and no outcome comment as a stalled ship —
but the in-skill bounded poll makes that a backstop, not the only signal.

---

## Step 3z — The dropped-trigger state (zero workflow runs) + bounded nudge

GitHub occasionally drops a `pull_request: synchronize` event server-side: the push updates
the head ref, but **no Actions runs ever fire for that SHA** (diagnosed in #1016 — a docs-only
push to PR #1013's head got zero runs for ~6 min until a close→reopen re-emitted the trigger,
after which the full suite ran, passed, and the PR merged). The symptom at Step 3 is an
**empty gating-check set with zero workflow runs behind the head SHA**: no red, nothing
pending, so the naïve read falls through to "every gating check is green" — a **false green**.
It is not green; there is no CI behind this commit at all.

This is a **distinct state**, and naming it precisely is the whole fix:

- it is **not** `checks pending` — there pending runs *exist*; here none fired;
- it is **not** a run-evidence-producer failure — Step 3.5's `unverified (no run-evidence
  bundle)` is "runs fired, but no bundle"; here **no runs fired at all**.

So its surfaced reason names the cause — **`no runs fired (dropped trigger)`** — never the
misleading `no run-evidence bundle`. (Before this state existed, a zero-runs head fell through
to a false green and was only caught — with that misleading reason — by Step 3.5's backstop;
the merge was still safely refused, but the drain loop got no actionable "just nudge it"
signal and could hang indefinitely on a never-run PR.)

**The remedy is a bounded close→reopen nudge.** Closing then reopening the PR re-emits the
`pull_request` trigger with the **head ref unchanged**, so the dropped workflows fire.
**ship-it performs the nudge itself** — it is a discrete server-side PR action like the merge,
not a wait-loop — then **stops** and leaves a **durable, PR-visible outcome comment** so the park
is observable, not silent (the same #1928 rule the branch-2 poll enforces): a re-dispatch after CI
settles resumes the ship. The nudge is **bounded to at most once per head SHA**, enforced
statelessly against the PR's own reopened-event history so a genuinely-stuck producer can never
loop:

```bash
# Have we ALREADY nudged this exact head? A nudge leaves a `reopened` event; count the ones
# that landed AFTER this head SHA was pushed (its committer date is the proxy for "since this
# commit"). >=1 ⇒ we already close→reopened this head and runs STILL didn't fire ⇒ the producer
# is genuinely stuck, not a dropped webhook ⇒ do NOT nudge again — refuse and hand to a human.
HEAD_PUSHED=$(gh api "repos/$REPO/commits/$HEAD_SHA" --jq '.commit.committer.date')
NUDGES=$(gh api "repos/$REPO/issues/$PR/events?per_page=100" \
  --jq "[.[] | select(.event==\"reopened\") | .created_at | select(. > \"$HEAD_PUSHED\")] | length")

if [ "${NUDGES:-0}" -ge 1 ]; then
  # Nudge exhausted → refuse and hand to a human, but leave a durable PR-visible signal (#1928):
  # never a silent stop even on this dead-end path.
  gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: unverified (no runs fired — nudge exhausted, producer may be stuck) — **not enqueued**. This head was already close→reopened once and CI still fired zero runs; handing to a human (#1928)." >/dev/null
  echo "unverified (no runs fired — nudge exhausted, producer may be stuck)"; exit 0   # refuse, hand to human
fi

# First (and only) nudge for this head: close then reopen over REST (never `gh pr close/reopen`
# or `gh pr edit` — Projects-classic breaks their GraphQL path in this org). The head ref is
# untouched, so every SHA-bound review verdict (Step 2) survives the reopen.
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=closed >/dev/null
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=open   >/dev/null
# Durable, PR-visible outcome so the park is observable (#1928): a re-dispatch after CI settles resumes the ship.
gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: nudged (close→reopen) — CI re-triggered, **not enqueued** yet. The head SHA had zero workflow runs (dropped trigger); ship-it close→reopened it once to re-emit the trigger. Re-dispatch ship-it once CI settles — idempotent (#1928)." >/dev/null
echo "nudged (close→reopen) — CI re-triggered, not yet merge-ready"; exit 0   # stop; re-dispatch after CI settles resumes the ship
```

The nudge **never bypasses verification** — it only restores the *missing runs*. A nudged PR
is handed back to the normal gate on the next invocation; the merge still requires a
current-head PASS (Step 2), green gating checks (Step 3), **and** a commit-bound, all-`pass`
run-evidence bundle (Step 3.5, guard 2). The close→reopen re-triggers CI; it does not advance
the merge by itself. Like Step 3's red and Step 2's FAIL, both Step 3z outcomes —
`nudged (close→reopen) …` and `unverified (no runs fired — nudge exhausted …)` — are a
**successful run that declines to merge**, not an error.

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

**Portability preflight (ADR [0086](https://github.com/kamp-us/phoenix/blob/main/.decisions/0086-ship-it-foreign-repo-degradation.md)).** The bundle is produced by phoenix CI
(`.github/workflows/run-evidence.yml` + `packages/pipeline-cli/src/tools/crabbox-manifest`), which the plugin does
**not** ship. A foreign repo that installed the pipeline therefore produces *no* bundle ever,
and a hard guard would make ship-it decline every merge there. So guard 2 is **conditional on
the repo producing run-evidence at all**: if this repo defines no `run-evidence` workflow, the
SHA-bound bundle is N/A and the gate falls back to the checks-green read (Step 3) — the bundle
degrades from a hard gate to a phoenix optimization, mirroring review-code's "a missing bundle
is never an error." This is a producer-presence test, **not** a per-PR escape: a repo that
*has* the producer but whose bundle is missing/stale/failing for this commit still refuses
below (that's a real gap, not portability).

```bash
# Does THIS repo produce run-evidence at all? (a workflow named "run-evidence" defined on the
# default branch). Absent → foreign repo → guard 2 N/A, gated on Step 3. Present → strict path.
# FAIL SAFE: degrade ONLY on a confirmed-empty result. A successful query returns a SINGLE
# count ("0", "1", …); an empty capture means the query itself FAILED (network / auth / rate-
# limit), which must NOT silently skip guard 2 — least of all in the home repo, where the
# strict path is invariant. So an unconfirmed lookup falls through to the strict path
# (HAS_PRODUCER=1), not to degradation: a transient API blip costs strictness, never a skipped
# bundle assertion. NOTE: no `--paginate` — with it, gh feeds each page to `--jq` separately so
# `| length` prints one integer PER PAGE (a multi-line "0\n0" that defeats both the `-z` guard
# and the `-eq 0` test). per_page=100 fits any realistic repo's workflow set in one page.
HAS_PRODUCER=$(gh api "repos/$REPO/actions/workflows?per_page=100" \
  --jq '[.workflows[] | select(.name=="run-evidence")] | length' 2>/dev/null)
[ -z "$HAS_PRODUCER" ] && HAS_PRODUCER=1   # lookup failed (empty) → can't confirm absence → strict
if [ "$HAS_PRODUCER" -eq 0 ]; then
  echo "guard 2 N/A (no run-evidence producer in this repo) — gated on checks (Step 3)"
  # Degraded: guard 2 clears here. Skip the bundle fetch + the four assertions below and
  # proceed to Step 4 on the strength of Step 2 (PASS) + Step 3 (gating checks green).
fi
```

When a producer **is** present (the phoenix home repo, or any adopter that ships the
run-evidence workflow), run the strict path unchanged:

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
# per-run bundle dir (mktemp -d), NOT a fixed /tmp/ship-it-bundle: concurrent §CP shippers
# fan out, and a shared path lets two racing runs read each other's bundle — merge-safety must
# not rest on Step 3.5's commit==head assertion catching the swap after the fact (#2281).
BUNDLE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ship-it-bundle.XXXXXX")
gh api "repos/$REPO/actions/artifacts/$ART_ID/zip" > "$BUNDLE_DIR/run-evidence.zip" 2>/dev/null \
  && unzip -oq "$BUNDLE_DIR/run-evidence.zip" -d "$BUNDLE_DIR"
MANIFEST="$BUNDLE_DIR/manifest.json"
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

- `unverified (no run-evidence bundle)` — runs fired for this head, but the run-evidence
  producer yielded no artifact / an empty manifest. (The *zero-runs* case — the head SHA had
  **no** workflow runs at all — is caught earlier in [Step 3z](#step-3z--the-dropped-trigger-state-zero-workflow-runs--bounded-nudge)
  with its own `no runs fired (dropped trigger)` reason + nudge, so it never reaches here as a
  misleading "no bundle.")
- `unverified (unsupported bundle schemaVersion: <v>)` — a schema major the gate can't read.
- `unverified (stale run-evidence bundle: commit <c> != head <h>)` — bundle isn't for this commit.
- `run-evidence checks failed (<names>)` — at least one `checks[]` entry is `fail` (or none present).

These four apply only when the repo **has** a run-evidence producer. When it does not, guard 2
is reported `guard 2 N/A (no run-evidence producer in this repo) — gated on checks (Step 3)`
and clears by degradation (ADR 0086) — a distinct, non-refusing outcome, not one of the four.

Only when the bundle exists, is schema-`1`, is commit-bound to the head SHA, **and** every
`checks[]` entry is `pass` (or the repo ships no producer and guard 2 degraded) does guard 2
clear — proceed to Step 4. Like Step 2's FAIL and Step 3's red, a bundle refusal is a
**successful run that declines to merge**, not an error.

> **Verified against fixtures (AC #5).** The assertion logic is exercised against manifests
> the producer tool's fixtures fold into — `packages/pipeline-cli/src/tools/crabbox-manifest/fixtures.ts`
> provides `passingRunSummary` (every command `exitCode: 0` → all `checks[]` `pass`) and
> `failingRunSummary` (the `test` command `exitCode: 1` → a `fail` check), which the adapter
> emits as `schemaVersion: 1` manifests stamped with `--commit`. Construct the two cases and
> run the assertions: a passing manifest stamped with `commit` == the PR head SHA clears all
> four; the failing one trips assertion 4 (`run-evidence checks failed (test)`); the same
> passing manifest stamped with a different `commit` trips assertion 3 (`stale`); a
> deleted/empty `manifest.json` trips assertion 1 (`no run-evidence bundle`); a manifest with
> `schemaVersion: 2` trips assertion 2. Each refusal is distinct — no silent pass.

```bash
# build a passing + failing manifest from the tool fixtures, then run the four assertions
# against each (commit-mismatch and missing-bundle are the same passing manifest mutated):
cd packages/pipeline-cli/src/tools/crabbox-manifest
HEAD_SHA=deadbeef
node ../../bin.ts crabbox-manifest --run-summary <(node -e 'console.log(JSON.stringify(require("./fixtures.ts").passingRunSummary()))') \
  --commit "$HEAD_SHA" --environment test --output /tmp/pass.json   # all checks pass → clears
node ../../bin.ts crabbox-manifest --run-summary <(node -e 'console.log(JSON.stringify(require("./fixtures.ts").failingRunSummary()))') \
  --commit "$HEAD_SHA" --environment test --output /tmp/fail.json   # test exit 1 → assertion 4 refuses
# /tmp/pass.json with commit != $HEAD_SHA → assertion 3 (stale); rm /tmp/pass.json → assertion 1
```

---

## Step 3.6 — Unresolved inline review threads gate: read them, route back by default (ADR 0158, guard 3)

An inline review thread — human **or** bot — whose resolution state is **unresolved** is a
merge-blocking signal, on the same footing as a `review-*: FAIL` verdict. Before you enqueue,
read the PR's unresolved threads and act on them. The `review-*: PASS` verdicts (Step 2), the
green CI (Step 3), and the run-evidence bundle (Step 3.5) attest the diff against the issue's
acceptance criteria — they do **not** see an inline "fix this" a human (or the code-quality bot)
left on a line. That objection was silently discarded before merge (#2123, the broadened
root-cause parent of #2121: the bot's unused-import thread shipped past every gate on PR #2113).
This step closes that hole in the pipeline-native path, independent of whether the ruleset's
`required_review_thread_resolution` flag is enabled (that server-side lever is founder-gated and
NOT flipped by this skill — ADR 0158 Consequences).

**The load-bearing crux (ADR 0158 §Decision 3): the default errs toward routing-back, NEVER
auto-dismiss.** A shipper that "resolves" a human's real objection just re-creates the throw-away
one layer down. So a **substantive** unresolved thread refuses the ship exactly like a FAIL; a
**genuine nit** may be resolved **only with an explicit written rationale**; and **when in doubt,
treat the thread as substantive and route back**. Never blanket-resolve threads to clear the gate.

### Reading thread resolution — the one sanctioned GraphQL read (ADR 0158 §Decision 2)

Thread **resolution** state (`isResolved`) is a **GraphQL** field
(`repository.pullRequest.reviewThreads[].isResolved`); the REST inline-comments endpoint
(`GET /repos/{o}/{r}/pulls/{n}/comments`) exposes the comments but has **no** `isResolved` field
and no thread grouping, so it cannot tell resolved from unresolved. Reading review-thread
resolution is therefore the **single, narrow, documented exception** to this skill's REST-only
rule — verified working on this org (the Projects-classic breakage is scoped to Projects fields,
not `reviewThreads`; grounded live on PRs #2113/#2122/#2107, ADR 0158). Every other read/write in
this skill stays REST.

```bash
ORG="${REPO%%/*}"; NAME="${REPO#*/}"
# The ONE GraphQL read in ship-it (ADR 0158): REST exposes no isResolved. Read every review thread's
# resolution state + its first author, so a substantive-vs-nit judgment has the thread text.
gh api graphql -f query='
  query($o:String!,$n:String!,$pr:Int!) {
    repository(owner:$o, name:$n) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          nodes {
            isResolved
            isOutdated
            path
            line
            comments(first:1) { nodes { author { login } body } }
          }
        }
      }
    }
  }' -F o="$ORG" -F n="$NAME" -F pr="$PR" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)
        | {path, line, author: .comments.nodes[0].author.login, body: (.comments.nodes[0].body[0:200])}'
```

### Disposition — classify each unresolved thread, then branch

For **each** unresolved thread the query returns:

- **Substantive** — a real objection: a requested change ("fix this", "handle this case", "this
  is wrong", "don't do X"), a bot finding that names a real defect (an unused import, a missing
  guard), or anything you cannot confidently call trivial. → **REFUSE to enqueue.** Report
  `unresolved substantive review thread (<path>:<line>, @<author>)` and stop — this is a FAIL-class
  refusal, routed back to `write-code` to address the thread on the branch. Do **not** resolve it.
- **Genuine nit** — a trivial, already-satisfied, or obsolete note (a style preference already
  followed, a question already answered in the diff, a finding a later commit made moot). → you
  **may** resolve it, but **only with an explicit written rationale**: reply on the thread stating
  *why* it is a nit, then resolve it. Never a silent or blanket resolve.

If **any** unresolved thread is substantive (or in-doubt), you refuse — the whole PR does not
enqueue. Only when **every** unresolved thread has been either addressed on the branch (so it no
longer shows unresolved) or resolved-with-rationale as a nit do you proceed to Step 4.

```bash
# Resolve a NIT thread — ONLY after posting the rationale reply. Requires the thread's node id
# (from the same GraphQL read, add `id` to the reviewThreads.nodes selection). REST cannot resolve
# a thread, so the resolve mutation is part of the same sanctioned GraphQL exception (ADR 0158).
# gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread { isResolved } } }' -F t="$THREAD_ID"
```

**Refuse in doubt.** A false route-back costs one cycle; a false auto-resolve silently discards a
real objection — the exact failure ADR 0158 closes. The conservative bias is the point, not a
rough edge. This guard is **additive**: it layers a new pre-enqueue refusal on the existing
sequence (Step 0 §CP approval, Step 2/2b current-head PASS, Step 3 green CI, Step 3.5
run-evidence) and weakens none of them.

---

## Step 3.7 — Landed-comment leak scan: refuse to enqueue a PR whose comments carry a machine-local path (guard 4)

Every leak guard *before* this one is **emit-side** — a step the emitter (a `review-*` reviewer, a
`write-code` progress comment, …) chooses to run: `verdict post`'s `emissionDefect`, its folded-in
read-back, the `review-*` MANDATE blocks. That makes them all bypassable in one deviation: a reviewer
who freelances a raw `gh api -f body=@$VERDICT_FILE` post skips the tool AND its verify in a single
off-mandate step, landing a `/private/tmp/…`/`@filepath` body on a public PR and producing no valid
marker — and **nothing off that reviewer's own transcript re-checks the comment that actually
landed** (the #3018 / #3005 bypass; issue #3019). This step closes that structural gap by moving the
one missing check to the gate **every** merge crosses, regardless of emit path.

Before you enqueue, scan the PR's **landed** comments — the issue conversation (where verdict markers
live) **and** the inline review comments — for a machine-local path leak, over the `gh api` REST
boundary. Reuse the shared `findCommentLeaks` detector via the pipeline-cli verb (the same pure
matcher `redact-leaks` and `verdict post` already consume — one detector, not a re-invented one):

```bash
# guard 4 — refuse the enqueue on ANY live leak in a landed comment (exit 2 = a leak; ADR 0092 fail-closed)
pipeline-cli leak-guard scan-pr "$PR" || {
  echo "ship-it: REFUSING to enqueue #$PR — a landed comment carries a machine-local path (issue #3019)." >&2
  echo "  Remediate, then re-run ship-it:" >&2
  echo "  1. redact each flagged comment body — pipeline-cli redact-leaks (the merged #3021 tool) preserves evidential shape;" >&2
  echo "  2. re-post the redacted body (a verdict via 'pipeline-cli verdict post', which now self-verifies the landed comment, #3019);" >&2
  echo "  3. the underlying issue is a bypassed emit path — route the PR back to repair so the leaking comment is re-emitted through the mandated choke point." >&2
  exit 1
}
```

Refuse **fail-closed**, exactly like the other pre-enqueue guards: a non-zero `scan-pr` (a live leak)
STOPS the ship — you do not enqueue, you route to remediation (redact via `redact-leaks`, re-post
through `verdict post`, and repair the bypass). This guard is **additive**: it layers a new
pre-enqueue refusal on the existing sequence (Step 0 §CP approval, Step 2/2b current-head PASS, Step 3
green CI, Step 3.5 run-evidence, Step 3.6 inline threads) and weakens none of them. It catches a
leaked comment **regardless of how it was emitted** — the property no emit-side guard can offer.

---

## Step 4 — Enqueue for squash-merge (auto-merge / merge queue)

Every guard cleared: not a control-plane PR without a current-head team approval (Step 0), the
required gates' latest verdicts are a current-head PASS (Step 2/2b), checks are green (Step 3),
the run-evidence bundle is present, commit-bound, and all-`pass` (Step 3.5), **no unresolved
inline review thread is substantive** (Step 3.6, ADR 0158), and **no landed comment carries a
machine-local path** (Step 3.7, issue #3019). **Enqueue** it for a squash merge — the
merge queue owns the final merge, testing the prospective batched merge result against a fresh
base before it lands (ADR
[0132](https://github.com/kamp-us/phoenix/blob/main/.decisions/0132-merge-queue-for-base-freshness.md)):

```bash
gh pr merge $PR --auto
```

Pass **no** merge-method flag: the merge queue owns the method (SQUASH, set in the ruleset),
so a `--squash` here **conflicts** with the queue and silently no-ops the enqueue (exits 0 but
does not add the PR to the queue). `--auto` alone enqueues cleanly.

`--auto` is the **universal-safe** mechanism across both regimes (ADR 0132's transition
safety): pre-queue it enables auto-merge (the PR merges when required checks pass); once
"require merge queue" is on, the same command **adds the PR to the queue** and the queue
performs the batched merge. Your success condition is therefore **enqueued + green**, not
"merged now": every guard above (Step 0's §CP refusal, Step 2/2b's current-head PASS, Step
3's green CI, Step 3.5's run-evidence bundle) still gates the enqueue exactly as before — the
**only** change is that the terminal merge is async (queue-owned) instead of immediate. Do
not treat a not-yet-merged state after a successful `--auto` as a failure: the merge lands
when the queue's batch goes green.

When there **is** a linked issue, the merge (whenever the queue completes it) auto-closes it
via its `Fixes #<ISSUE>` — that is the loop closing, now **asynchronously**. Do not separately
close the issue; let the `Fixes` seam do it when the merge lands. On the doc/vocab-surface-only
no-link path (`ISSUE` unset, ADR
[0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)) there is no
`Fixes #N` and nothing to auto-close — the PR simply enqueues and merges.

---

## Step 5 — Confirm enqueued + green, then surface the release queue on a dark merge

The final merge is **async** (queue-owned), so the terminal state to verify is **QUEUED**,
not `merged=true` in this run. Under the merge queue a *successful* enqueue leaves `auto_merge`
**`null`** — the queue, not an auto-merge request, owns the async merge — so the success signal
is the **`already queued to merge`** message the enqueue prints and/or the PR's `QUEUED` state
(read from `mergeStateStatus` + the `added_to_merge_queue` REST timeline event — **not** the
`mergeQueueEntry` `--json` field, which gh 2.62.0 rejects, #1930). See ADR 0132 addendum §3.

```bash
# The QUEUED signal is the success condition. `already queued to merge` from Step 4's --auto
# and/or an `enqueued`/QUEUED mergeStateStatus confirm it — NOT a non-null auto_merge, which
# under the queue stays null on a clean enqueue (ADR 0132 §3).
gh api repos/$REPO/pulls/$PR --jq '{merged, auto_merge, mergeable_state}'
# Derive QUEUED from `mergeStateStatus` PLUS the authoritative REST issue-timeline event
# (`added_to_merge_queue`) — NOT the `mergeQueueEntry` --json field, which the pinned gh
# 2.62.0 rejects, forcing an every-ship gh-api fallback (#1930). The last merge-queue timeline
# event is the same gh-2.62.0-safe source Step 5.5's reconcile already reads; both steps use one
# REST-timeline path for the QUEUED confirmation.
gh pr view $PR --json mergeStateStatus --jq '{mergeStateStatus}'
gh api "repos/$REPO/issues/$PR/timeline" \
  --jq 'map(select(.event=="added_to_merge_queue" or .event=="removed_from_merge_queue")) | last | .event // "no-merge-queue-event"'
```

A clean `--auto` under the queue leaves `auto_merge` **`null`** and reports `already queued to
merge`; that `null` is the **expected** post-enqueue shape, **not** a failure — do not read it
as one. `merged` may still be `false` at this instant; that is expected too — the queue completes
the squash merge when its batch goes green. Do **not** re-drive the PR or close the issue by hand
off a not-yet-merged state, and do **not** re-arm auto-merge because the field reads `null`.

**Do not use `null` `auto_merge` as a jam discriminator** (ADR 0132 addendum §1): a `null`
`auto_merge` on a clean enqueue is indistinguishable *at that field alone* from the
`allow_auto_merge=false` repo-wide jam. The reliable jam signal is Step 4's failure **string**
`Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`, not a `null` field
read as failure — so a genuine jam surfaces as an enqueue error, never as a "stuck at `null`" here.

Because the merge and its `Fixes #<ISSUE>` auto-close are async, **ship-it no longer asserts
`state: closed` in the same run** — the issue closes when the queue lands the merge. When
`ISSUE` is set, report it as `issue #<ISSUE> — closes async on queue merge`; if a later check
shows the queue merged but the issue didn't auto-close (a missing/garbled `Fixes #N`), that
broken seam is fixed upstream, not by a hand-close inside this run.

When `ISSUE` is **unset** there is no issue to auto-close — report by whichever Step 1 path
left it unset: `issue: n/a (doc/vocab-surface-only, no linked issue)` for the ADR-0075 path, or — when
Step 1 pinned `PART_OF` (an explicit `Part of #N` partial split) — `issue: #<PART_OF> left
open (intentional partial split, not auto-closed)`, confirming the partial-split issue stays
open for the sibling lane.

### Step 5.5 — Bounded post-enqueue reconcile: detect an ejection (QUEUED is not terminal success)

`QUEUED` is the enqueue **success** signal (Step 4), but it is **not** the terminal one. GitHub's
merge queue can **eject** an enqueued PR without merging it — the batch combining this PR with the
PRs ahead of it in the `gh-readonly-queue/<base>/…` ref hits a **textual conflict**, or the
combined batch **fails CI** (a logical/semantic conflict the queue bisects and removes the culprit
from) — and on ejection the PR is **silently dropped from the queue**: still open, no longer queued,
the async merge never happens, `Fixes #N` never fires, the issue stays open (GitHub docs,
[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
Under concurrent fleet merges — the exact regime the queue exists for (ADR 0132) — ejection is the
**expected** failure mode, not an edge case. Stopping at `QUEUED` therefore reports a **false
success**: to the pipeline an ejected PR is indistinguishable from a slow-but-still-pending one.
Close that hole with a **bounded post-enqueue reconcile** — it stays compatible with ADR 0132's
async model (the actor does **not** block synchronously on the final merge), it just watches a
**bounded batch window** to classify the terminal state before it reports.

Classify each poll off the **authoritative** merge-queue signal — GitHub's REST issue-timeline
events (`added_to_merge_queue` on enqueue, `removed_from_merge_queue` on a genuine ejection;
GitHub "Managing a merge queue") — **not** a momentary `mergeStateStatus`. The old discriminator
inferred `ejected` from `OPEN + mergeStateStatus != QUEUED`, but a freshly-enqueued PR reads
`mergeStateStatus = CLEAN` for a few seconds *before* GitHub flips it CLEAN → QUEUED, so a
genuinely-queued PR false-classified as `ejected` on the first poll (the #1906 live instance: an
ejection comment posted on a healthy queued PR, then retracted by hand — #1921). The fix adds a
fourth outcome, `pending` (the enqueue-settle window: OPEN, not merged, **no** merge-queue event
yet), which is **never** an ejection. The classification is a **pure, unit-tested** predicate in
`pipeline-cli merge-queue-classify` (`packages/pipeline-cli/src/tools/merge-queue-classify/`) — the
reconcile shells out to it per poll and branches on the printed outcome word:

```bash
# Bounded reconcile: poll the authoritative merge-queue state within a batch window, then classify.
# BOUNDED, not synchronous-to-merge (ADR 0132): a fixed budget of polls, then STOP and report —
# a PR still QUEUED at the budget's end is a well-formed pending, not a failure.
# The classifier reads PR state (gh pr view — the sanctioned PR-state read ship-it Step 2 uses,
# NOT a GraphQL intake query the org's Projects-classic integration breaks) + the last merge-queue
# timeline event (gh api …/timeline, REST) and prints merged/ejected/queued/pending. It is
# fail-closed away from a false ship: any unreadable signal ⇒ pending (keep polling), never a
# false merged/ejected.
RECONCILE_TRIES=${SHIP_RECONCILE_TRIES:-10}   # ~10 polls
RECONCILE_SLEEP=${SHIP_RECONCILE_SLEEP:-30}   # ~30s apart ⇒ ~5 min batch window
MERGE_OUTCOME=pending
for i in $(seq 1 "$RECONCILE_TRIES"); do
  MERGE_OUTCOME=$(pipeline-cli merge-queue-classify classify --pr "$PR" --repo "$REPO")
  [ "$MERGE_OUTCOME" = merged ] && break   # terminal success
  [ "$MERGE_OUTCOME" = ejected ] && break  # a genuine dequeue (removed_from_merge_queue) — act below
  # queued (still in the queue) or pending (enqueue-settle window) ⇒ keep polling within the budget
  sleep "$RECONCILE_SLEEP"
done
# At the budget's end a still-`pending` PR (never a merge-queue event) is reported as a well-formed
# pending, NOT ejected — the settle window is not an ejection (#1921).
```

Then act on `MERGE_OUTCOME`, and only here — **never at Step 4's enqueue** — decide the run's
merge disposition:

- **`merged`** — the queue landed the batch. Terminal success; the `Fixes #N` close has fired (or
  is firing) async. Report `merged: yes (queue landed the batch)`.
- **`queued`** / **`pending`** — the PR is still healthily in-flight at the window's end: `queued`
  is confirmed in the queue (last event `added_to_merge_queue`, or `mergeStateStatus == QUEUED`);
  `pending` is the **enqueue-settle window** (OPEN, not merged, no merge-queue event yet — incl.
  OPEN + CLEAN before the CLEAN → QUEUED flip). **Both are a well-formed pending, not a failure**
  (ADR 0132: the actor does not block to the final merge). Report `enqueued: yes (→ auto-merges on
  green)` exactly as before — the reconcile confirmed it was **still in-flight, never ejected**,
  within the window. A `pending` PR at the budget's end is reported this way too — the settle window
  is **never** an ejection (#1921).
- **`ejected`** — the queue **dropped** the PR (still open, no longer queued, not merged) — keyed on
  the authoritative `removed_from_merge_queue` timeline event, not on a momentary state. This is
  the silent stall this step exists to catch. Do **not** report shipped. **Route it back to
  repair/re-queue** and **surface the ejection**: leave a legible comment on the PR naming the
  ejection and the likely cause (textual batch conflict vs combined-batch CI failure), so the
  fleet/`drive-issue` shipper stage re-drives it (a fresh review at head → re-enqueue) instead of
  treating `QUEUED` as done:

  ```bash
  if [ "$MERGE_OUTCOME" = ejected ]; then
    gh api "repos/$REPO/issues/$PR/comments" -f body="ship-it: merge-queue **ejection** detected — PR #$PR was enqueued but the queue dropped it without merging (still open, no longer queued, not merged). Likely a textual conflict on the batch ref or a combined-batch CI failure (ADR 0132; GitHub \"Managing a merge queue\"). Routing back to repair/re-queue — this is NOT a shipped state." >/dev/null
  fi
  ```

  ship-it does **not** itself re-enqueue an ejected PR in the same run (a bare re-enqueue would
  loop on the same unmerged batch conflict); the ejection is surfaced and handed to the repair /
  re-queue lane (the `drive-issue.js` shipper stage consumes `ejected` and re-drives), the same
  fail → fix → re-request boundary write-code owns. The **success/watch distinction is now
  observable** — `QUEUED` never masks a stall, because the reconcile separated `merged` from
  `queued`/`pending` from `ejected` off the authoritative merge-queue timeline event, so an
  enqueue-settle window no longer masquerades as an ejection (#1921).

This reconcile **weakens no existing gate**: Step 0's §CP refusal, Step 2/2b's current-head PASS,
Step 3's green CI, Step 3.5's run-evidence bundle, and the single-merge-authority contract (ADRs
0048/0053/0132) all still gate the enqueue exactly as before — this only **adds** a bounded
post-enqueue observation that classifies the terminal state. It stays inside ADR 0132's async
model: it is a **bounded reconcile** (a fixed poll budget, then report), not a return to
synchronous block-to-merge.

### Step 5b — Surface the release queue (a dark merge is deployed, not released)

The enqueue above commits the merge — the agent's deployment boundary (ADR
[0083](https://github.com/kamp-us/phoenix/blob/main/.decisions/0083-agents-deploy-humans-release.md)
§1: *agents own deployment, humans own release*). When the merged change was a **user-facing
feature shipped dark** behind a default-off flag, deployment is **not** release: the feature is
on `main`, contained, invisible to users until a human flips the flag. ship-it's last act is to
**surface that change to the humans** by adding it to the release queue — the
`status:awaiting-release` label on the linked issue (the queue mechanism defined in
[#602](https://github.com/kamp-us/phoenix/issues/602)). The **issue** is the durable carrier:
the linked issue survives the async queue merge (it auto-closes when the merge lands, but the
label persists on it and is queryable by infra-admins), so the release queue rides the existing
label spine and adds no new artifact.

**ship-it NEVER flips the flag.** Release — the flag flip that makes the feature visible — is a
deliberate **human** act (infra-admins, the Cloudflare dashboard), never an agent step (ADR
0083 §1 and its Non-goals: *automating the flip is explicitly out of scope*). ship-it's role
ends at queueing; the human consumes the queue and flips. Applying the label is the **whole**
of the release-queue step — no flip, no notification, no second action.

This step keys off a **ground-truth signal of the merged PR itself** — *did this PR actually ship
a flag-gated dark feature?* — **not** the linked issue's `**Containment:**` stamp. That stamp
encodes the issue's *containment intent* and is routinely **inherited from an epic's blanket
stamp** (every child of a flag-containment epic carries `flag (default-off)` whether or not it
ships dark), so it is *necessary-but-not-sufficient*: a PR can carry the inherited stamp yet ship
**ungated** — an a11y/contrast/UX foundation on an existing surface, where gating it default-off
would ship the regressed state as the prod default. Keying off the stamp queued such a PR toward a
flag-flip **that does not exist**, pointing a human releaser at a phantom release and eroding trust
in the queue; today only per-shipper ad-hoc judgment ("this shipped ungated, so no queue") avoided
the false label. So ship-it **no longer reads the Containment marker here** (the bug issue #1257
closes). The marker's two contract-named readers in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)
§The-product-development-cycle-hook — `write-code` (ships dark) and `review-code` (verifies the
gating) — are **unchanged**; ship-it was never one of them, so dropping the read makes ship-it
*consistent* with that contract while making the release-queue decision **structural, requiring no
per-shipper judgment**.

The trigger is **three ground-truth signals of the PR**, any of which proves the merge shipped a
real dark feature:

- **(a) the diff introduces a flag.** The PR **adds** a default-off flag declaration in the
  flag-IaC surface — the canonical home is `apps/web/worker/features/flagship/resources.ts` (ADR
  [0081](https://github.com/kamp-us/phoenix/blob/main/.decisions/0081-feature-flag-substrate-cloudflare-flagship.md),
  epic #488). An added `Cloudflare.FlagshipFlag(` factory call or a `defaultVariation:` flag-config
  line there is a **real default-off flag this merge introduced** — the very artifact `write-code`
  Step 4b mints and `review-code` Step 3b verifies, so a genuine dark ship carries it.
- **(b) the PR body declares the flag key.** An explicit `Flag: <key>` / `Flag key: <key>` line
  naming the kebab-case flag this PR dark-ships — the fallback for a feature that gates behind a
  flag a **prior** PR already declared, so the flag resource isn't in *this* diff.
- **(c) the PR body names an already-declared flag key in a gating-declaration line.** The body
  carries a **dark-ship gating declaration** — a line asserting *this* PR ships dark behind a
  **real, currently-declared flag key** ("ships dark behind `phoenix-bildirim`") — the reused-flag
  dark-ship case where `write-code` phrased the flag in prose instead of emitting the canonical
  `Flag:` line, so signals (a) and (b) both miss (#2086). (c) fires on **two** grounds, both
  required: the key is **grounded against the actual registry of declared default-off flags** (the
  `key:` string literals in `resources.ts`, sourced from `apps/web/src/flags/keys.ts`), **and** it
  appears in a **gating context**, not documentation/example prose. Registry-grounding alone is
  *necessary but not sufficient* — it rules out arbitrary prose, undeclared/misspelled keys, and
  non-flag kebab tokens, but it does **not** distinguish a gating declaration from a docs/example
  mention of a genuinely-declared key, so a merely-illustrative reference (an example graduation
  query naming a real flag) mis-fired (c) and queued a **phantom** `status:awaiting-release`
  (#2897/#2843 — a new instance of the #1257 phantom-release class, via (c)'s context-blindness). The
  gating-context scoping in `FLAG_IN_PROSE` below closes that: (c) fires only on a line that both
  names a declared key **and** carries dark-ship gating intent — a truly ungated PR, and a PR that
  merely documents/exemplifies a flag key, both no-op.

It runs **only** when there is a linked issue *and* the cycle doc is present (the graceful absence
contract, ADR 0062 — an absent cycle doc means no flag substrate, hence nothing to release). With
those preconditions met, the merge queues `status:awaiting-release` **iff** signal (a), (b), or (c)
fires. When **none** fires the PR shipped **ungated** → this step **no-ops** regardless of the
issue's inherited stamp (exactly the #1211/#1212/#1213 foundation shape, addressing #1202). On
**no linked issue** (the doc/vocab-surface-only path) or an **absent cycle doc** it also no-ops — so the merge
behavior is exactly as it was before this dimension existed:

```bash
RELEASE_QUEUE="n/a (not a dark ship)"   # default: the no-op state

# Only a REAL dark ship has anything to queue: a linked issue + the cycle doc present (graceful
# absence, ADR 0062), THEN a ground-truth signal that THIS PR shipped a flag-gated feature — never
# the linked issue's (often epic-inherited) Containment stamp, the phantom-release bug #1257 closes.
if [ -n "$ISSUE" ] && gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1; then
  # (a) the DIFF introduces a flag: an ADDED declaration in the flag-IaC surface
  #     (apps/web/worker/features/flagship/resources.ts — the canonical flag home, ADR 0081).
  #     `+` patch lines are additions; an added `FlagshipFlag(` factory call or a `defaultVariation:`
  #     flag-config line is a real default-off flag THIS PR introduced (write-code Step 4b mints it,
  #     review-code Step 3b verifies it).
  FLAG_IN_DIFF=$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
    --jq '.[] | select(.filename | test("features/flagship/resources\\.ts$")) | .patch // ""' \
    | grep -E '^\+' | grep -Eq 'FlagshipFlag\(|defaultVariation:' && echo yes || echo no)

  # (b) the PR BODY declares the dark-ship flag key explicitly (a `Flag:`/`Flag key:` line naming a
  #     kebab-case key) — covers gating behind a flag a PRIOR PR already declared (not in THIS diff).
  #     The leading-prefix allowance absorbs only COSMETIC markdown — leading whitespace, an optional
  #     ATX header (`#{1,6}`, so `## Flag:` / `### Flag key:` match, #1293), and `**` bold — while the
  #     key grammar `[a-z0-9]+(-[a-z0-9]+)+` is untouched, so prose containing "flag" and a non-kebab
  #     key still miss.
  FLAG_IN_BODY=$(gh api repos/$REPO/pulls/$PR --jq '.body // ""' \
    | grep -Eiq '^[[:space:]]*(#{1,6}[[:space:]]*)?\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*[a-z0-9]+(-[a-z0-9]+)+' && echo yes || echo no)

  # (c) the PR BODY names an ALREADY-DECLARED flag key in a GATING-DECLARATION line (the reused-flag
  #     dark ship, #2086): the flag pre-dates this diff (so (a) misses) and write-code phrased it in
  #     prose — "ships dark behind `phoenix-bildirim`" — rather than the canonical `Flag:` line (so (b)
  #     misses). Two grounds, BOTH required (registry-grounding alone was necessary-but-not-sufficient
  #     — it let a docs/example mention of a real key mis-fire, the #2897/#2843 phantom awaiting-release):
  #     (1) the key is a REAL declared default-off flag — read the `key: <CONST>` list from the flag-IaC
  #     surface (resources.ts) on `main`, resolved to literals via apps/web/src/flags/keys.ts; AND (2) it
  #     appears in GATING context, not documentation/example prose (the FLAG_IN_PROSE scoping below).
  DECLARED_KEYS=$(
    gh api "repos/$REPO/contents/apps/web/worker/features/flagship/resources.ts?ref=main" \
        --jq '.content' 2>/dev/null | base64 -d 2>/dev/null \
      | grep -oE 'key:[[:space:]]*[A-Z0-9_]+' | grep -oE '[A-Z0-9_]+$' | sort -u > /tmp/shipit-flag-consts.$$ || true
    gh api "repos/$REPO/contents/apps/web/src/flags/keys.ts?ref=main" \
        --jq '.content' 2>/dev/null | base64 -d 2>/dev/null \
      | grep -oE '^export const [A-Z0-9_]+[[:space:]]*=[[:space:]]*"[a-z0-9]+(-[a-z0-9]+)+"' \
      | sed -E 's/^export const ([A-Z0-9_]+)[[:space:]]*=[[:space:]]*"([a-z0-9-]+)"/\1 \2/' \
      | while read -r CONST LIT; do grep -qx "$CONST" /tmp/shipit-flag-consts.$$ 2>/dev/null && echo "$LIT"; done
    rm -f /tmp/shipit-flag-consts.$$
  )
  FLAG_IN_PROSE=no
  if [ -n "$DECLARED_KEYS" ]; then
    BODY_PROSE=$(gh api repos/$REPO/pulls/$PR --jq '.body // ""')
    # Narrow (c) to a GATING/DECLARATION context — the fix for the #2897/#2843 phantom-release
    # false positive. A declared key mentioned only as documentation/example prose ("counts errors
    # captured while phoenix-bildirim was on") reads identically to a real dark-ship declaration
    # under a whole-body grep, so (c) mis-fired and queued a phantom status:awaiting-release. Two
    # scopers restore the distinction WITHOUT dropping (c)'s genuine reused-flag coverage (#2086):
    #   (i) drop fenced ```code``` blocks — an example dark-ship line shown INSIDE a fence is
    #       documentation ABOUT dark-shipping (e.g. a PR editing a pipeline skill), not THIS PR's own
    #       gating declaration.
    #  (ii) keep only GATING-CONTEXT lines — a line carrying `behind` PLUS a dark-ship/gating word,
    #       the exact prose write-code emits for a reused-flag dark ship it phrased instead of the
    #       canonical `Flag:` line ("ships dark behind `phoenix-bildirim`", the #2086 case (a)/(b)
    #       both miss). NOTE the inline `key` backticks are NOT stripped — the whole-token match below
    #       treats a backtick as a boundary char, so `ships dark behind \`phoenix-bildirim\`` still
    #       fires; a naive strip-inline-code fix would false-NEGATIVE this genuine case.
    #  The false positive has no such line (its mention carries no gating intent) ⇒ (c) no-ops.
    GATING_PROSE=$(printf '%s' "$BODY_PROSE" \
      | awk '/^[[:space:]]*```/{f=!f; next} !f' \
      | grep -Ei '(^|[^a-z])behind([^a-z]|$)' \
      | grep -Ei '(^|[^a-z])(dark|ship|ships|shipped|shipping|gate|gated|gates|gating|guard|guarded|hide|hides|hidden|flag)([^a-z]|$)' || true)
    while IFS= read -r K; do
      [ -z "$K" ] && continue
      # whole-token match: the declared key bounded by non-[a-z0-9-] on each side, so a longer key
      # containing this one as a substring (e.g. phoenix-bildirim-x) is NOT matched by phoenix-bildirim
      printf '%s' "$GATING_PROSE" | grep -Eq "(^|[^a-z0-9-])$K([^a-z0-9-]|\$)" && { FLAG_IN_PROSE=yes; break; }
    done <<EOF
$DECLARED_KEYS
EOF
  fi

  if [ "$FLAG_IN_DIFF" = yes ] || [ "$FLAG_IN_BODY" = yes ] || [ "$FLAG_IN_PROSE" = yes ]; then
    # deployed-dark (a real flag shipped) → add the linked issue to the release queue for a human flip (#602)
    gh api -X POST "repos/$REPO/issues/$ISSUE/labels" -f "labels[]=status:awaiting-release"
    RELEASE_QUEUE="queued (awaiting human flip)"
  fi
  # no signal ⇒ the PR shipped ungated (the inherited-stamp false positive #1257 closes) ⇒ no-op, no label
fi
```

The `status:awaiting-release` label is **orthogonal to the `status:*` pickability spine** — it
is a post-merge *release* state, never a thing `write-code` keys on (#602). Applying it to an
already-closed issue is fine: an infra-admin lists the queue with a one-line filter
(`gh api "repos/$REPO/issues?state=all&labels=status:awaiting-release"`), flips the flag in the
dashboard, then clears the label as the release completes (#602's consume flow). This step is
**idempotent** — re-running ship-it on an already-merged dark PR re-adds a label the issue
already carries (or a still-open-but-enqueued issue), a GitHub no-op.

---

## Running it

A single invocation ships one PR end to end: classify the diff against the control-plane
boundary and refuse if it touches one (Step 0, guard 0), resolve the PR ↔ issue (Step 1),
resolve the latest verdict per required gate namespace, refuse any verdict not bound to the
PR's current head (Step 2b, ADR 0058), and enqueue only if every required one is a current-head
PASS (Step 2, guard 1), confirm the gating checks are green (Step 3), assert the SHA-bound run-evidence bundle
exists / is schema-readable / is commit-bound / is all-`pass` (Step 3.5, guard 2), enqueue for
squash-merge with `--auto` (Step 4), confirm enqueued + green (Step 5), **bounded-reconcile the
enqueue to catch a queue ejection** before reporting shipped (Step 5.5), and surface the release
queue on a dark merge (Step 5b). The queue owns the final merge — success is **enqueued + green,
reconciled to landed-or-still-queued** (never a silent ejection), and the issue-close is async
(ADR 0132).

Report back a tight terminal ledger — nothing else, because the merge itself is the
durable record:

```
PR #<PR> — issue #<ISSUE>
branch: <head ref>
PR url: <html_url>
enqueued: yes (QUEUED → auto-merges on green) | no (<reason if no>)
merge: landed (queue merged the batch) | still queued (pending, reconciled) | EJECTED (routed to repair/re-queue)
issue: closes async on queue merge | n/a (doc/vocab-surface-only, no linked issue) | #<PART_OF> left open (partial split)
release: queued (awaiting human flip) | n/a (not a dark ship)
```

The `enqueued:` line is the enqueue success condition: `yes (QUEUED → auto-merges on green)` once
`--auto` armed the merge (Step 4). The `merge:` line is the **reconciled terminal outcome** (Step
5.5) — the queue owns the final, async merge, so the issue-close also lands async (ADR 0132),
reported as `issue: closes async on queue merge`. There is no in-run `merged: yes` / `issue closed:
yes` **assertion** any more — asserting an immediate merge would false-fail every enqueued PR — but
the bounded reconcile **does** distinguish `landed` from `still queued` from `EJECTED`, so `QUEUED`
never masks a silent stall. An `EJECTED` outcome is **not** a shipped state: it routes back to
repair/re-queue (Step 5.5), never reported as success.

The `release:` line is the deployment/release boundary made visible (ADR 0083): `queued
(awaiting human flip)` when Step 5b's ground-truth signal fired (the PR introduced a default-off
`FlagshipFlag` in the diff, or its body declared the dark-ship flag key) and it applied
`status:awaiting-release`; `n/a (not a dark ship)` when the PR shipped **ungated** (no flag
in the diff, no flag key declared — regardless of any inherited issue Containment stamp), on an
absent cycle doc, or on a doc/vocab-surface-only / unlinked PR. ship-it never flips the flag — the queued line
hands the release to a human, it does not perform it.

When `ISSUE` is unset (the doc/vocab-surface-only no-link path, Step 1 / ADR
[0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)) the issue
line renders `issue: n/a (doc/vocab-surface-only, no linked issue)` instead of `issue #<ISSUE>`, and
`release:` renders `n/a (not a dark ship)` (no linked issue ⇒ nothing to queue).

If you refused to enqueue, the reason line is the whole point: `awaiting control-plane approval`
(a §CP PR with no current-head `@kamp-us/control-plane` approval — Step 0, ADR 0135),
`unverified (no review-code PASS)`, `unverified (no review-doc PASS)`, `unverified (no
review-skill PASS)`, `unverified (verdict
not bound to current head)` (a SHA-less or stale-head verdict — Step 2b, ADR 0058), `latest
verdict is FAIL (<gate>)`, `routed to heal-ci` (a gating red check, handed to the self-heal lane),
`refused — CI still pending after <budget>` (the bounded CI-settle poll ran to its budget with a
gating check still unfinished — Step 3, #1928; a durable PR outcome comment is posted, and a
re-dispatch on the now-green head enqueues cleanly), the dropped-trigger outcomes (Step 3z):
`nudged (close→reopen) — CI re-triggered, not yet merge-ready` (the head SHA had zero workflow
runs; ship-it close→reopened it once to re-emit the trigger, posted a durable PR outcome comment,
and stopped — re-dispatch after CI settles) or `unverified (no runs fired — nudge exhausted,
producer may be stuck)` (already nudged once and still zero runs → handed to a human, with a
durable PR outcome comment), `no linked issue`, or a run-evidence refusal (Step 3.5):
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
