---
name: ship-it
description: Ship one verified PR on the configured target repo — the authorized merge step the rest of the pipeline defers to. Given a PR number, assert the matching gate has signalled PASS (review-code for code, review-doc for docs, review-skill for skills), confirm CI is already green, squash-merge, confirm the linked issue auto-closed, and — when the merge was a dark feature ship — surface a release queue for the humans (deploy is the agent's boundary, release is human; ADR 0083). It REFUSES to self-merge control-plane PRs (.claude/.github + the gate-critical skills), which a human merges by hand (ADR 0053). Trigger on "ship #N", "ship it", "it's merge-ready, ship it", "close the loop on #N", "merge #N", "/ship-it". This is the terminal stage of the issue-intake pipeline: it consumes the merge-ready signal the gates produce and is the ONLY skill granted merge authority.
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
  superseding 0063's `review-code` routing) — and the human reads that verdict, then merges by
  hand. **Every OTHER `claude-plugins/kampus-pipeline/skills/**`** (triage, plan-epic, write-code, heal-ci, report, …) stays
  **non-blocking** — `review-skill`-routed and auto-merged on a PASS, because those skills
  neither merge nor verify, so a bad edit still has to clear the gate that does. ADR 0065's
  blocking rule is **unchanged** by 0073: `review-skill` is the *verdict* gate; merge-authority
  (blocking) is the *separate* axis 0065 owns, and 0065 stands verbatim until a later decision
  retires it against `review-skill`'s evidence (ADR 0073 §4).
- **NON-BLOCKING — autonomous.** Everything else — `apps/**` (every app worker), `packages/**`,
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

## The merge-ready signals

The pipeline runs **three gates**, one per artifact class, each landing its verdict as a
first-line marker comment:

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
- **code:** under any app worker, a package, or the glossary (`apps/**`, `packages/**`, or
  `.glossary/**` — the `^(apps|packages|\.glossary)/` probe, covering **every** `apps/<app>` worker,
  not just `apps/web`); a source path matching none
  of the three probes still defaults to code, requiring a `review-code` PASS, so nothing under-gates.
  The probe spans `apps/**` (not `apps/web/**`) so a future second worker like `apps/<other>/**` — code
  **or** README — is `review-code`-gated like `apps/web`, and `.glossary/**` is `review-code`-gated
  because Step 3c reads + enforces it (#912/#919); it agrees exactly with the docs probe's
  `apps/**`/`.glossary/**` exclusion below (the two must name the same code roots, or such a path would
  class as neither code nor docs and slip through ungated — #663).
- **docs:** `.decisions/**`, `.patterns/**`, or a prose `*.md` *outside* `.claude`/`.github`,
  **outside `claude-plugins/kampus-pipeline/skills/**`**, **outside the code roots `apps/**`/`packages/**`**,
  **and outside `.glossary/**`** — exactly
  `review-doc`'s verification scope. `claude-plugins/kampus-pipeline/skills/**` is the skill class, an `*.md` under
  `apps/**`/`packages/**` (a package/app-internal README, CHANGELOG, etc.) ships with its code
  artifact and is **`review-code`'s** scope, and `.glossary/**` is owned by `review-code` Step 3c —
  so all three are carved out of docs *before* the `.md$`
  match. The docs class is thus the surface a `review-doc` PASS can actually gate — see the
  scope-consistency note after the routing.

```bash
FILES=$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename')   # --paginate + streaming --jq: full set past file #100 (the API caps per_page at 100; the grep probes below aggregate the concatenated lines) (#725)
# §CP travels in the INJECTED skill snapshot, which can lag origin/main even when the on-disk file
# is current — a pre-amendment snapshot once auto-merged a now-control-plane PR (#981). So the
# literal below is the fail-closed reference + the validate-gate-path-drift lockstep target, NOT the
# live decision source: the regex actually classified is re-resolved from origin/main right after it.
CONTROL_PLANE_RE='^(\.claude|\.github)/|^claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-plan)/|^claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\.md$|^claude-plugins/kampus-pipeline/hooks(/|\.json$)|^packages/ci-required/|^packages/pipeline-cli/'   # the §CP canonical set — one definition (ADR 0073 §6; hooks added by 0103/#1003; the standalone -guard clause retired with those packages by #1003)
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
echo "$FILES" | grep -Eq '^claude-plugins/kampus-pipeline/skills/' && echo "has-skills"   # skill-class probe → review-skill (ADR 0073, supersedes 0063)
echo "$FILES" | grep -Eq '^(apps|packages|\.glossary)/' && echo "has-code"   # code probe: ALL app workers (apps/**) + packages + .glossary/** — agrees with the docs-probe exclusion below (#663/#919); review-code owns the glossary (Step 3c); skills/** is its OWN class (ADR 0073)
# docs probe EXCLUDES the code roots, skills/**, AND .glossary/** first, so a code/app-internal README
# (apps/**, packages/**), a skills-only .md, or a .glossary/** touch is NOT classed docs — only a prose
# .md on review-doc's own surface is (#542/#650/#919). The §DOC contract is the single source — cite, don't re-derive.
echo "$FILES" | grep -Ev '^(claude-plugins|apps|packages|\.glossary)/' | grep -Eq '^(\.decisions|\.patterns)/|\.md$' && echo "has-docs"
```

**Routing:**

- If **any** file is control plane (the §CP set — `.claude/**`, `.github/**`, or a
  gate-critical skill) → **REFUSE.** Report `blocking — manual merge` and stop. A human merges
  the control plane by hand (ADR 0053; gate-critical skills added by ADR 0065, with
  `review-skill/**` added by ADR 0073); the pipeline never self-merges its own guardrails.
  This holds even if the rest of the diff is clean code/docs/skills — a mixed PR that touches
  the control plane is still a manual merge, and should be split so the non-blocking half can
  flow. This refusal short-circuits **before** the namespace check below, so it never conflicts
  with the fact that a gate-critical `claude-plugins/kampus-pipeline/skills/**` PR is still `review-skill`-routed (ADR 0073):
  the routing decides *which gate's verdict the human reads*, this refusal decides *who merges*.
  A `claude-plugins/kampus-pipeline/skills/**` PR that touches **no** gate-critical skill is **not** blocking — it flows
  through `review-skill` and auto-merges on a PASS.
- Otherwise, note which **artifact classes are present** (skills, code, docs, or a mix). Step 2
  requires the matching gate's latest verdict = PASS for **each class present**: skills →
  `review-skill` PASS; code → `review-code` PASS; docs → `review-doc` PASS; a mixed PR needs a
  current-head PASS in **each** namespace present. Carry the class set into Step 2.

**The docs class must equal `review-doc`'s verification scope, or the gate it demands is
unreachable.** ship-it requires a class's gate PASS *because that gate runs on that class* —
so the docs probe may only class as docs a path a `review-doc` PASS can actually gate. The
`.md$` match is therefore **scoped, not over-matching**: it runs only after `grep -Ev
'^(claude-plugins|apps|packages|\.glossary)/'` carves out the path-classes whose `.md` is **not** review-doc's
(this is the §DOC contract — cite it, don't re-derive the carve-out here):

- **`claude-plugins/kampus-pipeline/skills/**`** — a skill `.md` is `review-skill`-gated (ADR 0073). Classing it docs would
  demand a `review-doc` PASS that never comes (the original #358 deadlock, closed by the
  dedicated gate).
- **`apps/**` / `packages/**`** — a package/app-internal `*.md` (a README, CHANGELOG) ships
  with its code artifact and is **`review-code`'s** scope: `review-code` reviews the whole
  `apps/**`/`packages/**` tree, README included, and `review-doc` explicitly disclaims that tree
  (its Step 0 routes the `apps/**` workers — `apps/web`, … — and `packages/**`
  to `review-code`). Classing such a `.md` docs demanded a `review-doc` PASS no gate ever produces —
  review-code gates and PASSes the tree, but no doc gate runs on it — so a clean, fully-gated
  product PR that merely *includes* a package README **deadlocked** (`unverified — no review-doc
  PASS`), the exact defect on PR #644 (#542/#650). Carving the code roots out makes the present
  class always have a reachable gate.
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
docs probe carves out `^(claude-plugins|apps|packages|\.glossary)/` and the has-code probe is `^(apps|packages|\.glossary)/`:
both span the **full `apps/**` tree** (every app worker — `apps/web`, and any future app), not
just `apps/web`, **and both name `.glossary/**`**. That agreement is the invariant — if the two
diverged (e.g. has-code stayed `apps/web` while docs excluded all `apps/**`), an `apps/<other>/**`
path — code `.ts` **or** `README.md` — would class as **neither** has-code (the narrow probe misses
it) **nor** has-docs (the docs exclusion drops it), and ship-it would demand **no** gate at all and
merge it **ungated**. Widening has-code to `apps/**` closes that hole (#663): every `apps/<app>` path
now classes has-code and rides its `review-code` PASS, exactly as `apps/web` always has.

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
weakening no other guard — control-plane refusal, SHA-binding, and the green-CI requirement all
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
class — resolve it; Step 4's squash-merge auto-closes it via `Fixes #<ISSUE>`, with Step 5's
explicit-close fallback.

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
for this one explicit marker. This is a **parallel** allowance to the docs-only carve-out below
(ADR [0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)),
not the same one: docs-only is *issueless* (nothing to close); a partial split *names an issue
it intentionally keeps open*. The `Part of #N` marker is a non-closing mention by construction —
GitHub never populates `closingIssuesReferences` from it (only a closing keyword does;
[gh-issue-intake-formats.md §9](../gh-issue-intake-formats.md)) — which is exactly why the merge
leaves `#N` open.

If there is **no** linked issue, the rule is **class-aware** — reuse the artifact classes
Step 0 already computed (do **not** re-derive them; ADR
[0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)):

- **A code or skills class is present** (anything other than docs-only) **with no issue
  reference at all** — neither a closing keyword **nor** the explicit `Part of #N` partial-split
  marker above → stop and report `no linked issue`. In this pipeline `write-code` always writes
  `Fixes #N` (or, for a deliberate partial split, `Part of #N`), so a code PR that names **no**
  issue at all is a broken seam, not a normal state — it has nothing to auto-close on merge and
  would leave dangling work. (Distinct from the *linked-but-didn't-auto-close* case Step 5
  handles: there the seam fired but GitHub didn't, which is recoverable; here no issue is named
  on a code PR, an anomaly worth stopping on. Also distinct from the partial-split above, where
  `Part of #N` names the issue **on purpose** to keep it open — that merges, this refuses.)
- **Docs-only** (Step 0 classed `docs` with **no** code and **no** skills class present) → a
  missing `Fixes #N` is a **legitimate state, not a broken seam**. A conversation-authored
  ADR/doc records a settled choice that was never tracked work, so there is nothing for a
  `Fixes #N` to close. Skip the auto-close expectation, leave `ISSUE` unset, and **proceed to
  the gate check** — the docs-only PR ships on its `review-doc: PASS` alone (Step 2). Emit
  **no** `no linked issue` refusal; it is not an anomaly. This relaxes **only** the missing-link
  guard: Step 0's control-plane refusal and Step 2's required current-head `review-doc: PASS`
  are untouched — a docs-only PR still needs its gate verdict.

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
comments_file=$(mktemp)
gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$comments_file"

# distinct logins that posted any review-code/review-doc/review-skill marker
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*(PASS|FAIL)"; "i"))
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
2. **Else, any check pending** (no gating red, some unfinished) → report `checks pending —
   not yet merge-ready` and stop. The caller re-invokes you after CI settles; blocking on a
   multi-minute poll inside this atomic stage is out of scope.
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
not a wait-loop — then **stops**; the *re-read after CI settles is the caller re-invoking
ship-it*, the same atomic contract as `checks pending` (Step 3 owns no poll). The nudge is
**bounded to at most once per head SHA**, enforced statelessly against the PR's own
reopened-event history so a genuinely-stuck producer can never loop:

```bash
# Have we ALREADY nudged this exact head? A nudge leaves a `reopened` event; count the ones
# that landed AFTER this head SHA was pushed (its committer date is the proxy for "since this
# commit"). >=1 ⇒ we already close→reopened this head and runs STILL didn't fire ⇒ the producer
# is genuinely stuck, not a dropped webhook ⇒ do NOT nudge again — refuse and hand to a human.
HEAD_PUSHED=$(gh api "repos/$REPO/commits/$HEAD_SHA" --jq '.commit.committer.date')
NUDGES=$(gh api "repos/$REPO/issues/$PR/events?per_page=100" \
  --jq "[.[] | select(.event==\"reopened\") | .created_at | select(. > \"$HEAD_PUSHED\")] | length")

if [ "${NUDGES:-0}" -ge 1 ]; then
  echo "unverified (no runs fired — nudge exhausted, producer may be stuck)"; exit 0   # refuse, hand to human
fi

# First (and only) nudge for this head: close then reopen over REST (never `gh pr close/reopen`
# or `gh pr edit` — Projects-classic breaks their GraphQL path in this org). The head ref is
# untouched, so every SHA-bound review verdict (Step 2) survives the reopen.
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=closed >/dev/null
gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=open   >/dev/null
echo "nudged (close→reopen) — CI re-triggered, not yet merge-ready"; exit 0   # stop; caller re-invokes after CI settles
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
(`.github/workflows/run-evidence.yml` + `packages/crabbox-manifest`), which the plugin does
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

When there **is** a linked issue, the merge auto-closes it via its `Fixes #<ISSUE>` — that
is the loop closing. Do not separately close the issue; let the `Fixes` seam do it. On the
docs-only no-link path (`ISSUE` unset, ADR
[0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)) there is no
`Fixes #N` and nothing to auto-close — the PR simply merges.

---

## Step 5 — Confirm the loop closed, then surface the release queue on a dark merge

Verify the terminal state rather than assuming the merge took. Always confirm the PR
`merged` state; the issue-close confirmation is **conditional on a linked issue** (ADR
[0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)):

```bash
gh api repos/$REPO/pulls/$PR --jq '{merged, merged_at}'
if [ -n "$ISSUE" ]; then
  gh api repos/$REPO/issues/$ISSUE --jq '{state, state_reason}'
fi
```

When `ISSUE` is set, it should now read `state: closed`, `state_reason: completed`. If it
didn't auto-close (a missing/garbled `Fixes #N`), close it explicitly with a one-line note
pointing at the merged PR — but record that the seam was broken so it can be fixed upstream.

When `ISSUE` is **unset** there is no issue to auto-close — skip the close-confirmation query
and report by whichever Step 1 path left it unset: `issue: n/a (docs-only, no linked issue)`
for the ADR-0075 docs path, or — when Step 1 pinned `PART_OF` (an explicit `Part of #N`
partial split) — `issue: #<PART_OF> left open (intentional partial split, not auto-closed)`,
confirming the partial-split issue stays open for the sibling lane.

### Step 5b — Surface the release queue (a dark merge is deployed, not released)

The merge above is **deployment complete** — the agent's boundary (ADR
[0083](https://github.com/kamp-us/phoenix/blob/main/.decisions/0083-agents-deploy-humans-release.md)
§1: *agents own deployment, humans own release*). When the merged change was a **user-facing
feature shipped dark** behind a default-off flag, deployment is **not** release: the feature is
on `main`, contained, invisible to users until a human flips the flag. ship-it's last act is to
**surface that change to the humans** by adding it to the release queue — the
`status:awaiting-release` label on the linked issue (the queue mechanism defined in
[#602](https://github.com/kamp-us/phoenix/issues/602)). The **issue** is the durable carrier:
the PR is closed by the merge above, but the linked issue survives (it auto-closed, but the
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

The trigger is **two ground-truth signals of the PR**, either of which proves the merge shipped a
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

It runs **only** when there is a linked issue *and* the cycle doc is present (the graceful absence
contract, ADR 0062 — an absent cycle doc means no flag substrate, hence nothing to release). With
those preconditions met, the merge queues `status:awaiting-release` **iff** signal (a) or (b)
fires. When **neither** fires the PR shipped **ungated** → this step **no-ops** regardless of the
issue's inherited stamp (exactly the #1211/#1212/#1213 foundation shape, addressing #1202). On
**no linked issue** (the docs-only path) or an **absent cycle doc** it also no-ops — so the merge
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
  FLAG_IN_BODY=$(gh api repos/$REPO/pulls/$PR --jq '.body // ""' \
    | grep -Eiq '^[[:space:]]*\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*[a-z0-9]+(-[a-z0-9]+)+' && echo yes || echo no)

  if [ "$FLAG_IN_DIFF" = yes ] || [ "$FLAG_IN_BODY" = yes ]; then
    # deployed-dark (a real flag shipped) → add the linked issue to the release queue for a human flip (#602)
    gh api -X POST "repos/$REPO/issues/$ISSUE/labels" -f "labels[]=status:awaiting-release"
    RELEASE_QUEUE="queued (awaiting human flip)"
  fi
  # neither signal ⇒ the PR shipped ungated (the inherited-stamp false positive #1257 closes) ⇒ no-op, no label
fi
```

The `status:awaiting-release` label is **orthogonal to the `status:*` pickability spine** — it
is a post-merge *release* state, never a thing `write-code` keys on (#602). Applying it to an
already-closed issue is fine: an infra-admin lists the queue with a one-line filter
(`gh api "repos/$REPO/issues?state=all&labels=status:awaiting-release"`), flips the flag in the
dashboard, then clears the label as the release completes (#602's consume flow). This step is
**idempotent** — re-running ship-it on an already-merged dark PR re-adds a label the issue
already carries, a GitHub no-op.

---

## Running it

A single invocation ships one PR end to end: classify the diff against the control-plane
boundary and refuse if it touches one (Step 0, guard 0), resolve the PR ↔ issue (Step 1),
resolve the latest verdict per required gate namespace, refuse any verdict not bound to the
PR's current head (Step 2b, ADR 0058), and merge only if every required one is a current-head
PASS (Step 2, guard 1), confirm the gating checks are green (Step 3), assert the SHA-bound run-evidence bundle
exists / is schema-readable / is commit-bound / is all-`pass` (Step 3.5, guard 2), squash-merge
(Step 4), confirm the issue closed and surface the release queue on a dark merge (Step 5/5b).

Report back a tight terminal ledger — nothing else, because the merge itself is the
durable record:

```
PR #<PR> — issue #<ISSUE>
branch: <head ref>
PR url: <html_url>
merged: yes | no (<reason if no>)
issue closed: yes | no
release: queued (awaiting human flip) | n/a (not a dark ship)
```

The `release:` line is the deployment/release boundary made visible (ADR 0083): `queued
(awaiting human flip)` when Step 5b's ground-truth signal fired (the PR introduced a default-off
`FlagshipFlag` in the diff, or its body declared the dark-ship flag key) and it applied
`status:awaiting-release`; `n/a (not a dark ship)` when the merged PR shipped **ungated** (no flag
in the diff, no flag key declared — regardless of any inherited issue Containment stamp), on an
absent cycle doc, or on a docs-only / unlinked PR. ship-it never flips the flag — the queued line
hands the release to a human, it does not perform it.

When `ISSUE` is unset (the docs-only no-link path, Step 1 / ADR
[0075](https://github.com/kamp-us/phoenix/blob/main/.decisions/0075-issueless-doc-pr-merge-seam.md)) the two issue
lines render `issue: n/a (docs-only, no linked issue)` instead of `issue #<ISSUE>` and
`issue closed:`, and `release:` renders `n/a (not a dark ship)` (no linked issue ⇒ nothing to queue).

If you refused to merge, the reason line is the whole point: `blocking — manual merge`,
`unverified (no review-code PASS)`, `unverified (no review-doc PASS)`, `unverified (no
review-skill PASS)`, `unverified (verdict
not bound to current head)` (a SHA-less or stale-head verdict — Step 2b, ADR 0058), `latest
verdict is FAIL (<gate>)`, `routed to heal-ci` (a gating red check, handed to the self-heal lane),
`checks pending`, the dropped-trigger outcomes (Step 3z): `nudged (close→reopen) — CI
re-triggered, not yet merge-ready` (the head SHA had zero workflow runs; ship-it close→reopened
it once to re-emit the trigger and stopped — re-invoke after CI settles) or `unverified (no runs
fired — nudge exhausted, producer may be stuck)` (already nudged once and still zero runs →
handed to a human), `no linked issue`, or a run-evidence refusal (Step 3.5):
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
