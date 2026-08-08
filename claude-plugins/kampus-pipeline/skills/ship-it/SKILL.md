---
name: ship-it
description: Ship one verified PR on the configured target repo — the authorized merge step the rest of the pipeline defers to. Given a PR number, assert the matching gate has signalled PASS (review-code for code, review-doc for docs, review-skill for skills), confirm CI is already green plus the SHA-bound run-evidence bundle, then enqueue for a squash merge with `gh pr merge --auto` (no method flag — the queue owns the SQUASH method) — the merge queue owns the final, async merge, so success is "enqueued + green" (QUEUED → auto-merges on green) and the linked issue auto-closes async when the merge lands (ADR 0132) — then a bounded post-enqueue reconcile watches a batch window to catch a merge-queue ejection (a dropped PR — still open, no longer queued, not merged), routing an ejected PR back to repair/re-queue instead of reporting a silent false success. When the ship was a dark feature ship it surfaces a release queue for the humans (deploy is the agent's boundary, release is human; ADR 0083). For a control-plane PR (.claude/.github + the gate-critical skills) it is APPROVAL-AWARE (ADR 0135, amending 0053) — it enqueues the §CP PR only once a @kamp-us/control-plane team member has APPROVED it at the current head (all machine gates still green), else STOPS at "awaiting control-plane approval" — human judgment via the approval, pipeline mechanics via the enqueue. Every path that does NOT enqueue clears the `--auto` merge intent (`pipeline-cli merge-intent disarm`, ADR 0198) so a later bare approval can never enqueue ahead of these gates. Trigger on "ship #N", "ship it", "it's merge-ready, ship it", "close the loop on #N", "merge #N", "/ship-it". This is the terminal stage of the issue-intake pipeline: it consumes the merge-ready signal the gates produce and is the ONLY skill granted merge authority.
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

**Run each step's script by literal path and read its answer off stdout (ADR
[0232](https://github.com/kamp-us/phoenix/blob/main/.decisions/0232-agents-execute-skill-scripts-never-source-them.md)).**
This skill's steps are scripts under `scripts/`, and you **run** them:

```bash
bash ./.claude/.pipeline/skills/ship-it/scripts/<name>.sh <args…>
```

Two constraints make that the only shape, and both are the harness's: its isolation verifier refuses
a `.`/`source` at an agent's top-level command **by any path form**, and it refuses the interpolated
`"${CLAUDE_PLUGIN_ROOT:-…}/…"` idiom as too complex to verify. So the path is written out literally,
which hardcodes the in-repo plugin location — the ADR
[0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md)
portability trade ADR 0232 accepts and records.

**Read the exit status first, then the stdout.** Exit 0 means the script produced its answer on
stdout; a non-zero means it could not, which is UNKNOWN and never the permissive branch (§ZS / ADR
0092). Two of this skill's conventions sharpen that, and both are stated at each step below:

- **A refusal is not a failure to run.** Most of ship-it's stop paths are *successful declines* —
  they print their `refused — …` / `unverified (…)` line and exit **0**, exactly as the fenced blocks
  did. Where a step works that way, read the **terminal word** on stdout, not the status.
- **Every value a step used to leave in your shell now arrives as a `NAME=value` line**, and you
  re-pass it as the next step's argument. Nothing survives between your Bash calls, so a step that
  needs `$PR`, `$CP_FLAG`, `$CURRENT_HEAD` or the run-evidence handles is *handed* them.

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
5. **An unresolved inline review thread (human or bot) blocks the merge — and only a BOT's may
   ever be resolved.** Before you enqueue, read the PR's unresolved inline threads (Step 3.6) and
   branch on **author class first**: a **human-authored** thread — or one whose class you cannot
   positively derive as a bot — **always** refuses the ship like a FAIL, routed back to
   `write-code`, with no nit exception and no override; a **bot-authored** one keeps the ADR 0158
   judgment (substantive → refuse; genuine nit → resolvable **only with an explicit written
   rationale**; in doubt → substantive) (ADR
   [0224](https://github.com/kamp-us/phoenix/blob/main/.decisions/0224-ship-it-resolves-bot-threads-never-human-threads.md),
   amending ADR
   [0158](https://github.com/kamp-us/phoenix/blob/main/.decisions/0158-unresolved-review-thread-is-a-merge-gate.md)).
   A shipper that "resolves" a real objection just re-creates the throw-away one layer down — never
   blanket-resolve threads to clear the gate.
6. **You never leave a merge intent armed.** `gh pr merge --auto` is a durable *request*: an arm
   that outlives the run that made it enqueues the PR the moment the last requirement lands — on a
   §CP PR, the instant a human approval arrives — with no ship-it run asserting guards 1–5 in
   between. So an armed intent may exist **only** between a fully-gated Step-4 enqueue and the
   queue accepting the PR; every other path clears it (see
   [the no-parked-merge-intent invariant](#no-parked-merge-intent) below, ADR
   [0198](https://github.com/kamp-us/phoenix/blob/main/.decisions/0198-no-parked-merge-intent.md)).

<a id="no-parked-merge-intent"></a>
## The no-parked-merge-intent invariant — `--auto` never outlives its run (guard 6)

When `--auto` does not take effect at the head it was made against — a requirement unmet, or the
run interrupted mid-ship — GitHub keeps the request **armed** and fires it later, unattended. On
PR #3700 that armed leftover enqueued the PR **one second after** the approving review, before the
ship-it run that was supposed to gate the enqueue had started; the run then found it `already
queued to merge` and merely confirmed the guards after the fact ([#3723](https://github.com/kamp-us/phoenix/issues/3723)).
The approval requirement held throughout — the defect is purely one of **ordering**: the
assertions this skill makes *at* enqueue time can be skipped at the decisive instant. The bad case
the arm permits is concrete: a §CP PR enqueued → ejected → rebased → re-approved **re-enqueues on
the re-approval alone**, even with a missing run-evidence bundle at the new head.

The enqueue primitive is unchanged (`gh pr merge --auto`, Step 4). What is added is a lifecycle
rule with **four mandated sites** — run start, every stop/refusal, an ejection, and after the
bounded reconcile:

The primitive lives in
[`scripts/disarm-intent.sh`](scripts/disarm-intent.sh). Every step script that has a stop path
sources it in-chain for `disarm_intent`, so you never invoke it yourself on the ordinary paths —
each of those steps prints `INTENT_UNCLEARED=<0|1>` and that is what your outcome line carries. Run
it directly only to clear an intent outside a step (stdout is the same one line):

```bash
bash ./.claude/.pipeline/skills/ship-it/scripts/disarm-intent.sh <owner/repo> <pr> <preflight|refuse|post-enqueue|ejected>
```

**Site 1 is Step 0's `disarm_intent preflight || exit 1`, and it is the one that catches the
interrupted run** — #3700's actual mechanism, which by definition reaches no exit path of its own,
so no `refuse` site can ever fire for it. An intent armed by an earlier or interrupted run is
backed by no gate pass at this head. Abort the run if it cannot be cleared: a ship that cannot
establish the intent state cannot honor the invariant at any later site.

**Site 2 is every path that stops or refuses**, without exception — each runs `disarm_intent
refuse` **before it reports**. A run that declines to enqueue must not leave behind the means to
enqueue without it. The refusal strings enumerated in [Running it](#running-it) are that set; in
step order they are Step 0's `awaiting control-plane approval`, Step 1's `draft` /
`closed (unmerged)` / `no linked issue`, Step 2 guard 1's `latest verdict is FAIL (<gate>)`, Step
2/2b's `unverified …`, Step 3's gating red, the CI-settle refusals, Step 3z's dropped-trigger
nudge, Step 3.5's run-evidence refusals, Step 3.6's human-authored / underivable / substantive-bot
thread and its unreadable-read refusal, and Step 3.7's leak. Read
the rule, not the list: a stop path this list forgot is still a Site-2 path, and Site 1 is the
backstop that clears whatever any exit missed on the *next* run. Sites 3 and 4 (`ejected`,
`post-enqueue`) live in Step 5.5, where the terminal state is known.

A failed disarm **never rewrites a stop path's own control flow** — each site records
`INTENT_UNCLEARED=1` and continues to its existing disposition (so the durable PR-visible outcome
of #1928 and the `heal-ci` routing are untouched) — but it **does** change what the run reports:
an outcome line for a run with `INTENT_UNCLEARED=1` must name it, because "ship-it declined" and
"ship-it declined and left the merge armed" are different facts.

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
  (canonical shape: [the gate-verdict contract §VERDICT](../shared/gate-verdict-contract.md)).
  `review-code` can also land a native **approving review** (`event=APPROVE`), whose
  `commit_id` is its bound SHA.
- **docs** (`.decisions`, `.patterns`, prose `*.md` outside `.claude`/`.github`, outside
  `claude-plugins/kampus-pipeline/skills/**`, and outside the code roots `apps/**`/`packages/**` — a package/app-internal README
  is `review-code`'s scope, not this class; see Step 0) → `review-doc`, whose marker is
  `review-doc: PASS @ <sha> — merge-ready` or
  `review-doc: FAIL @ <sha> — changes-requested` (canonical shape: §VERDICT). `review-doc` is
  **comment-only** — it never lands a native review (ADR 0058), so the doc lane is a single
  comparable record type, not a review-vs-comment mix.
- **skills** (`claude-plugins/kampus-pipeline/skills/**`) → `review-skill`, whose marker is
  `review-skill: PASS @ <sha> — merge-ready` or `review-skill: FAIL @ <sha> — changes-requested`
  (canonical shape: §VERDICT). `review-skill` is **comment-only** like `review-doc` (ADR 0058). This
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
# stdout: `PR=<n>` — the run's PR, which you re-pass as every later step's second argument — then one
# changed-file path per line. A refusal (the §RO-iso stop, or a guard-6 Site-1 disarm that failed)
# prints NO `PR=` line, names itself on stderr, and exits non-zero: read the status first.
bash ./.claude/.pipeline/skills/ship-it/scripts/step0-preflight.sh <owner/repo> <pr number>
```

Classify each path. The classification is **derived by the shared verb `pipeline-cli cp-classify`**,
never by a boundary grep hand-rolled here — the same entry point the other gates run, so the answer
that decides a merge cannot drift from the answer that decided the review (formats §CP, #4161/#4405).

Two properties of that verb are what make it a legitimate substitute for the derivation this step
used to carry, and neither may be traded away. It **re-resolves `CONTROL_PLANE_RE` from `origin/main`
at run time** (`?ref=main`): the boundary is defined **once** in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §CP (ADR 0073 §6; the three
independent copies are the #375 drift class §CP closes), and the *embedded* copy travels in the
injected snapshot, which can lag `origin/main` even when the on-disk file is current — a
pre-amendment snapshot once auto-merged a now-control-plane PR (#981). Re-deriving at merge time,
against **main's** boundary rather than the PR's own edit of it, is the anti-self-authorization
property; it moved **into** the verb, it did not become a compile-time import. And it answers on
**both** §CP axes — path *and* the ADR-0164 content clause — so a guard-touching `.decisions/**` ADR,
which is §CP with **zero** path matches, cannot read as ordinary product work (#4134).

The verb returns **four** states, and only one of them is a non-§CP answer. Assert on the **stdout
state word**, never on a bare non-zero exit: `not-control-plane` exits **3**, and the exit code
discriminates the states only *once the verb has run* — a usage error prints help and exits 1, a
missing binary exits 127, and neither is a classification. Everything that is not a positive
`not-control-plane` is **held**:

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

**The two immovable canonical assignments — they stay in this file, at column 0.** `UI_RE`
and `UI_EXCLUDE_RE` are single-sourced *here*, and every live consumer re-resolves these exact
lines from the default branch at run time (the #981 anti-self-authorization design):
`pipeline-cli class-probe` parses them, `reviewer.md` and `review-design`'s Step 0 off-ramp
re-read them, and `validate-gate-path-drift.sh` asserts each appears exactly once at column 0
in this file. The classification shell that consumes them moved into a sourced script; these
two lines cannot (#4448).

```bash
UI_RE='^apps/web/src/'
UI_EXCLUDE_RE='\.(test|spec)\.tsx?$'
```

```bash
# stdout, in order: `CP_STATE=<state>`, then one `BLOCKING (…)` line per §CP finding, then one class
# word per class present (`has-skills` / `has-code` / `has-docs`) and `has-ui` when the diff renders a
# surface. The ordinary §CP answer is the ABSENCE of a BLOCKING line, so read `CP_STATE=` as the
# evidence the derivation ran — never emptiness. A classification that could not be made prints
# `STOP: …` and exits 1; that is UNKNOWN, never "no gates required".
bash ./.claude/.pipeline/skills/ship-it/scripts/step0-classify.sh <owner/repo> <pr number>
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
  - **discharge** → the human-judgment gate is satisfied; **set the Step-2 §CP seam**, then **carry
    on** into Step 2's normal machine
    gates (matching-gate SHA-bound PASS, CI green, run-evidence). The seam is the literal token
    `--cp`, **printed by the approval gate's discharge branch as `CP_FLAG=--cp`**, and that branch is
    its **only** source — a §CP PR's pass path is the SHA-less advisory, which `verdict gate` counts
    only under `--cp` (Step 2), and the discharge is exactly the condition that licenses it. Carry
    that token forward as the **third argument** to Step 2's gate and its native-review fold. Read no
    `CP_FLAG=` line ⇒ pass nothing, which is the stricter branch: an omitted seam can only refuse a
    §CP PR, never pass one (#4547).

    Once those pass, ENQUEUE exactly
    like a non-§CP PR (`gh pr merge --auto`, no method flag — the queue owns the SQUASH method;
    QUEUED → auto-merges on green; §CP PRs now
    enter the ADR 0132 queue too). §CP carries **one extra** gate — the team approval — layered on
    the same machine gates every PR clears.
  - **stop** (the cardinality branch's required current-head signal is absent, or the team is
    empty) → **STOP.** Run `disarm_intent refuse || INTENT_UNCLEARED=1` (guard 6 — this is *the*
    stop the parked-intent defect fires on: the approval this PR is waiting for would otherwise
    enqueue it the instant it lands), then report `awaiting control-plane approval` and stop; do
    **not** enqueue. This
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

  **Every input to this gate is a fallible READ, and an unresolved one is UNKNOWN — never a
  cardinality, never "the team is empty", never `awaiting control-plane approval` (#4223).** All four
  — roster, author, head, per-approver membership — come from **§CPREAD** / **§CPREAD-APPROVAL** of
  [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), which the step script sources
  in-chain from their extracted home, `../shared/scripts/cp-read.sh` (single source; the why, and the
  measurement behind it, live there, not here — and no paste step for the shipper to forget, #4547).
  Each failure branch stops under a message that names the read that failed.

  ```bash
  # stdout: exactly one `§CP approval: …` line, plus `CP_FLAG=--cp` on the discharge branch only —
  # that token is the Step-2 seam, and this is its only source. A branch that could not answer names
  # the failed read on stderr and exits 1: UNKNOWN, never `awaiting control-plane approval`.
  bash ./.claude/.pipeline/skills/ship-it/scripts/step0-cp-approval.sh <owner/repo> <pr number>
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
If it's `draft` or `state=closed` (unmerged) → run `disarm_intent refuse || INTENT_UNCLEARED=1`
(guard 6 — a Site-2 stop like any other), then stop and report why.

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
  the explicit `Part of #N` partial-split marker above → run `disarm_intent refuse ||
  INTENT_UNCLEARED=1` (guard 6), then stop and report `no linked issue`. In
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

<a id="step-2-gate"></a>
### Step 2 gate — `verdict gate` is the enqueue precondition: run it FIRST, refuse on non-zero

**Run this before any other Step-2 read, and treat a non-zero exit as a hard stop.** It resolves,
in one fail-closed decision, the thing the rest of Step 2 describes: does **every** namespace this
PR's diff requires carry a verdict that was **affirmatively read, bound to the PR's live head, and a
pass**? A green exit is the **only** sanctioned path past guard 1 — no bypass, and no "I read the
namespaces and they looked fine."

The required set is **derived, never eyeballed** — the same `class-probe` output the reviewer fan
dispatches off, so `dispatched-gate == required-gate` holds by construction:

```bash
# stdout: one `ship-it guard 1: …` line naming the required namespaces. The EXIT STATUS is the gate —
# 0 only when `verdict gate` passed every required namespace; every refusal names itself on stderr
# and exits 1. Pass `--cp` as the THIRD argument only when Step 0's approval gate printed it.
bash ./.claude/.pipeline/skills/ship-it/scripts/step2-verdict-gate.sh <owner/repo> <pr number> [--cp]
```

**The one input this step takes beyond the PR is the §CP seam, and Step 0 already decided it.** Step
0's §CP discharge branch is its only source — it prints `CP_FLAG=--cp` — and every other path prints
nothing, which the script reads as the non-§CP branch. So pass the token **iff you read it off that
branch's stdout**, verbatim, and otherwise omit the argument entirely. Deciding `--cp` here, from your
own reading of the diff, is the [defect this seam replaced](https://github.com/kamp-us/phoenix/issues/4547):
it puts the §CP decision back where an eyeball makes it, next to the verb that is supposed to be
handed it.

**Why a verb and not a careful read.** The rule below was already correct in prose ("docs present
but the review-doc namespace is empty → `unverified (no review-doc PASS)`"), but nothing *computed*
it: the shipper resolved each namespace with a separate `verdict read` and then decided **by
eyeball** whether the union covered every required namespace. That leaves the **absence** branch to
an agent's attention, and PR #3944 enqueued with **no verdict bound to its live head at all** — the
one FAIL on it was bound to a *superseded* head, so at enqueue time nothing attested the tree being
merged (#3982). "No verdict found" must be a **refusal**, not a pass-through, and absence is a
property of the required **set** — so it can only be decided where the set is known, which is
exactly what a per-namespace `read` cannot do. The verb makes the invalid state unrepresentable;
`decideGate`'s unit tests are the contract, including the #3944 stale-head reproduction.

The verb refuses, with the named reason, on **every** non-pass state: a namespace with no verdict at
all, a verdict bound to a stale head, a SHA-less pre-0058 marker, a §CP advisory whose
`Reviewed-head` is stale or whose body carries a `[FAIL]` checkbox, a current-head FAIL, an **empty
required set** (zero required gates would make the conjunction vacuously true — an un-gated merge
dressed as a pass, ADR 0092), and an unresolvable head.

**`--cp` is load-bearing in both directions, and it belongs on `read` too.** A §CP PR's pass is the
SHA-less advisory, which a `read` **without** `--cp` cannot see at all — it resolves `_tag: none`,
the **expected** §CP shape, not an absent verdict — and a §CP PR must **never** be required to carry
(nor be satisfied by) a bindable first-line `PASS @ <sha>` (that drops the §CP verdict into the
auto-merge namespace, the ADR 0111 hazard). Pass `--cp` **only** for a PR Step 0 classified §CP whose
control-plane approval gate already passed; without it the advisory is correctly not a pass. Pass the
**same** `$CP_FLAG` to the code-namespace `verdict read` in the native-review fold below: both verbs
resolve one in-force verdict from the same (PR, gate, head, §CP-ness) tuple, so feeding them
different §CP-ness is the only way left to make them disagree (#4049).

**The one signal the verb does not read — apply it on top.** `verdict gate` reads marker/advisory
*comments*, not GitHub's native reviews. So a green `verdict gate` is **necessary, not sufficient**:
the native-review fold below still applies to the review-code namespace, and a **newer**
`CHANGES_REQUESTED` review than the marker still flips that namespace to FAIL and refuses. Run the
verb first, then the fold; never let a green verb suppress a newer decisive review.

The rest of Step 2 is the **explanation** of what that verb decides, plus the native-review fold it
cannot see. Read it to understand a refusal — do not re-implement the conjunction by hand.

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
[the gate-verdict contract §VERDICT](../shared/gate-verdict-contract.md) and ADR
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

**ship-it resolves no authorized-author set of its own — the verb owns that lookup for every
namespace, advisory included.** This step used to rebuild the ACL set here, on the stated ground that
the §CP advisory resolution (Step 2.§CP) needed a set `verdict read` could not supply. That ground no
longer holds, and the set it built had no consumer left: `pipeline-cli verdict gate` resolves
`authorizedAuthors` itself from the same GitHub ACL, and `gate-decision` applies it to the **advisory**
pick exactly as it does to a marker — the author-gate's scope covers PASS / FAIL / advisory alike. So
the §CP advisory *is* author-gated; it is gated one layer down. Rebuilding the set here bought a
comments fetch plus one collaborator-permission call per marker author, per ship, for a value nothing
read (#4405).

The fail-closed direction is unchanged and now lives in one place: a lookup error or a `read`/`triage`
author never enters the set, so their marker is ignored exactly as an off-list author was under 0051,
and when *no* author clears the bar the set is empty, nothing resolves, and the gate refuses
`unverified`. An empty authorized set is the safe terminal state, not an open door.

Resolve the **in-force** verdict per namespace **through `pipeline-cli verdict read`**: the verb folds
the ADR-0055 write+ author-gate (a forged newer marker from an unauthorized author can't shadow a real
verdict), the in-force pick, and the ADR-0058 SHA-staleness refusal (Step 2b) into one exit code — its
unit tests are the contract (#2102), the same resolution `write-code` reads.

**The in-force rule, stated once and used by every namespace below: filter candidates to the ones
bound to the LIVE head first, then take the most recently WRITTEN of those.** Two things follow from
`verdict post` upserting a verdict in place (ADR 0213/#4016/#4050), and `created_at` — when the comment
SLOT was opened, not when the verdict it now carries was written — gets both wrong:

- Never "the newest comment in the namespace, then check its head": a stale-but-freshly-created verdict
  then outranks an at-head one that was rewritten in place. That is a false **refusal** of a green PR,
  and it cost PR #3955 an hour (#4189).
- Never order two LIVE-HEAD verdicts by `created_at` either: an in-place correction keeps its slot's
  creation time, so it loses to a sibling run's merely-newer comment. Here the head filter admits both
  candidates and there is no staleness test left to catch the mis-pick, so it also runs **fail-open** —
  a FAIL upserted after a PASS is silently cleared (#4200). The ordering key is the `Verdict-written:`
  stamp `verdict post` writes into every body (floored at `created_at`, so an unstamped legacy comment
  is unaffected); `verdict read` reports it as `writtenAt`, which is the ONLY timestamp a fold below
  may compare against.

The same trap catches a human skimming the PR, since the GitHub UI orders by creation time too — read
the `@ <sha>` / `Reviewed-head:` binding and the `Verdict-written:` stamp, never the position.
The native decisive review folds into the code namespace separately (the verb reads marker comments,
not reviews), and that fold applies the ADR-0058 staleness test inline, at the fold itself:

```bash
# stdout: `CURRENT_HEAD=<40-hex>`, `CODE_PASS=<0|1>`, `CODE_FAIL=<0|1>` — the folded code-namespace
# verdict. Carry `CURRENT_HEAD` forward: Step 3's settle wait compares against it to catch a head
# that moved mid-poll. The exit status answers "could I resolve them", never "is it a PASS" — a
# folded FAIL is `CODE_FAIL=1` at exit 0. Pass the same `--cp` token Step 2's gate got, or omit it.
bash ./.claude/.pipeline/skills/ship-it/scripts/step2-native-review-fold.sh <owner/repo> <pr number> [--cp]
```

Now resolve **per namespace** (the marker verdict from the verb above, the native review + §CP
advisory folded in):

- **review-code namespace** — the verdict is the **newest of {latest decisive review, in-force
  review-code marker comment}**, compared by WRITE time (review `submitted_at` vs the verdict's
  `writtenAt`) **only once both are current-head-bound** — the head-first rule above, which is
  what the `case "$CURRENT_HEAD" in "$RSHA"*` guard and the `_tag == "current"` marker test encode.
  An `APPROVED` review or a `review-code: PASS … merge-ready` marker is PASS; a
  `CHANGES_REQUESTED` review or a `review-code: FAIL` marker is FAIL. The verdict's bound SHA
  is the marker's `@ <sha>` (or, for a native review, its `commit_id`). (The native
  approving-review path stays; it interleaves only with the review-code markers, never with
  review-doc.) A **§CP** code PR's verdict is likewise the SHA-less-first-line advisory
  (`review-code: advisory — blocking-set PR …`) — §ADVISORY/ADR 0151 converges **all four** gates on
  the one advisory form, so a §CP review-code advisory is resolved from the body's canonical
  `Reviewed-head` line via the
  **[§CP advisory resolution](#step-2cp--cp-advisory-namespace-resolution-adr-01350151)** below
  (ADR 0111/0151), gated on Step 0's control-plane approval — **never** from a bindable first-line
  marker (that would drop the §CP verdict into the auto-merge namespace, the ADR 0111 hazard). This
  is the written resolution path a canonical review-code §CP advisory previously lacked (#2329).
- **review-doc namespace** — the verdict is the **in-force `review-doc` marker comment** (the rule
  above); its bound SHA is the marker's `@ <sha>`. `review-doc: PASS … merge-ready` is
  PASS; `review-doc: FAIL … changes-requested` is FAIL. (review-doc lands no native review —
  it is comment-only, ADR 0058 — so there is no review path to fold in, and no review-vs-comment
  comparison to make.) A §CP doc PR's verdict is likewise the SHA-less-first-line advisory
  (`review-doc: advisory — blocking-set PR …`), resolved for a §CP PR from the body's
  `Reviewed-head` line via the same
  **[§CP advisory resolution](#step-2cp--cp-advisory-namespace-resolution-adr-01350151)** below
  (ADR 0111/0151) — never from a bindable first-line marker.
- **review-skill namespace** — the verdict is the **in-force `review-skill` marker comment** (the
  rule above); its bound SHA is the marker's `@ <sha>`. `review-skill: PASS … merge-ready` is
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
- **review-design namespace** — the verdict is the **in-force `review-design` marker comment** (the
  rule above); its bound SHA is the marker's `@ <sha>`. `review-design: PASS … merge-ready` is
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
bound to `X1` can never be consumed against `X2`). The rule, per namespace:

- **No bound SHA** (a pre-0058 SHA-less marker) → `unverified (verdict not bound to current
  head)` → refuse.
- **Bound SHA ≠ current head** (neither is a prefix of the other — either may be abbreviated,
  so compare by prefix-match against `$CURRENT_HEAD`) → `unverified (verdict not bound to
  current head)` → refuse.
- **Bound SHA prefix-matches `$CURRENT_HEAD`** → the verdict is current; its polarity decides
  in the guard below.

**For the marker namespaces this refusal is now enforced *inside* `pipeline-cli verdict read`**
(Step 2): a marker that is SHA-less or bound to an older head resolves `sha-less`/`stale`, so the
verb exits non-zero on **both** `--expect PASS` and `--expect FAIL` — leaving `<g>_PASS=0` **and**
`<g>_FAIL=0`, which is exactly `unverified (verdict not bound to current head)` → refuse. There is
no separate marker staleness test to run here, and none to keep in sync (#2102).

Every `unverified …` here is a stop path, so it runs `disarm_intent refuse` before reporting
(guard 6): the head that moved out from under the verdict is the same head an armed intent would
enqueue behind your back — ADR 0058's staleness rule and ADR 0198's are one rule applied to two
artifacts.

Two signals `verdict read` does not resolve carry the test elsewhere, and **neither is applied
here**: the **native review**'s `commit_id` is tested inline at the Step-2 fold (the `[ -n "$RSHA" ]`
emptiness short-circuit followed by the `case "$CURRENT_HEAD" in "$RSHA"*` prefix-match), and the
**§CP advisory**'s body `Reviewed-head` SHA is tested inside `verdict gate --cp`. The empty-SHA
short-circuit is the load-bearing half in both: an unguarded `case "$CURRENT_HEAD" in ""*)` reduces
to the glob `*`, which matches any head and would falsely report a SHA-less verdict as current (ADR
0058 rule 3).

<a id="step-2cp--cp-advisory-namespace-resolution-adr-01350151"></a>
### Step 2.§CP — resolve a §CP advisory namespace from the body's `Reviewed-head` line (ADR 0135/0151)

> **Owned by the verb — this section is the reference explanation, and carries no runnable code.**
> This resolution now runs inside `pipeline-cli verdict gate --cp` ([Step 2 gate](#step-2-gate)):
> author-gate the advisory the same way as a marker, take latest-wins across marker *and* advisory,
> read the head from the body's `Reviewed-head` anchor, and require every body checkbox `[PASS]`. Read
> this section to understand a §CP refusal; do not hand-roll the resolution beside the verb.

**This step runs only for a PR Step 0 classified §CP whose approval gate passed** (a current-head
`@kamp-us/control-plane` team approval is present — else Step 0 already STOPPED at `awaiting
control-plane approval`, and you never reach here). A §CP `review-skill` / `review-doc` PR's *only*
verdict is the **SHA-less-first-line advisory** (ADR 0111): its first line carries no `@ <sha>`, so
the Step-2 first-line matcher above resolves that namespace's `sha` to `null` and Step 2b would
refuse it as a legacy SHA-less marker. That refusal is **correct for a non-§CP PR** but is the
#1932/#2022 collision for a §CP one — the advisory is the *intended* §CP verdict, and its reviewed
head is bound **in the body**, not the first line. So for the §CP advisory namespaces, resolve the
reviewed head from the body's **canonical `Reviewed-head: @ <sha>` line** (mandated in
the gate-verdict contract's §ADVISORY and emitted by the review-skill/review-doc advisory templates,
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
advisory (§ADVISORY/ADR 0151 converges **all four** gates on one advisory form), so its body
`Reviewed-head` line resolves the enqueue exactly like the doc/skill/design namespaces — without it,
a canonical review-code §CP advisory had no written resolution path and read as `sha: null` → refused
on a legitimately-approved PR (#2329).

The three conditions below **describe `gate-decision`'s branches; they are not a procedure to run.**
This section used to carry them as a fenced bash block that read an `$ADV_BODY` variable **nothing
ever assigned** — so it could not execute even if followed literally, while looking exactly like the
authoritative §CP resolution to anyone auditing the merge gate (#4405). The in-force advisory those
conditions apply to is picked by the verb: author-gated write+ (ADR 0055) and ordered by its
`Verdict-written:` stamp, never by `created_at`, because an advisory is upserted in place too.

- **(a) The body's canonical `Reviewed-head: @ <sha>` line (ADR 0151, §ADVISORY) must prefix-match the PR's
  current head.** The verb anchors on the `Reviewed-head:` token — deliberately *distinct* from the
  first-line advisory marker — so the body binding is never confused with a first-line marker and the
  advisory stays out of the PASS namespace. Two separate refusals fall out: an advisory carrying **no**
  `Reviewed-head` body binding at all, and one whose binding is **stale** against the current head.
- **(b) Every checkbox in the body is `[PASS]`** — a single recorded `[FAIL]` anywhere refuses
  `§CP <namespace> advisory not all-PASS`.
- **(c) Step 0's current-head `@kamp-us/control-plane` approval** — already asserted before you reach
  here. All three together make this §CP namespace a current-head PASS-equivalent for the class gate
  below.

A §CP namespace with **no** advisory comment at all (nor any PASS/FAIL marker) is still
`unverified (no review-<code|skill|doc> PASS)` — the resolution needs a current-head advisory to read.
A §CP namespace whose latest verdict is a `review-<code|skill|doc>: FAIL` marker is a **FAIL** (the
reviewer found a miss), refused exactly as a non-§CP FAIL — the §CP advisory path is entered only
when the latest verdict is an *advisory*, never to mask a FAIL.

Then gate the merge on the classes present (Step 0). **This conjunction is what
[Step 2 gate](#step-2-gate)'s `verdict gate` computes** — the list below names each refusal it emits,
so a reason printed by the verb maps to a line here; it is not a second place to re-derive the check
by hand:

1. For **each class present**, its namespace must have a latest verdict, it must be **bound to
   the current head** (Step 2b, or Step 2.§CP for a §CP advisory namespace), and it must be PASS
   (or, for a §CP advisory namespace, the Step 2.§CP PASS-equivalent). **A namespace with no
   verdict at all is this same refusal** — absence is never a pass-through (#3982).
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
   has unaddressed failures as its *current* state, even if an older PASS exists. Run
   `disarm_intent refuse || INTENT_UNCLEARED=1` (guard 6 — a FAIL'd PR that still carries an arm
   would enqueue on the next approval with its failures unaddressed), report
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
comment — never a silent park. A bare exit code can't cleanly separate red from pending, and no
aggregate tells a *gating* check from an *informational* one — so read the per-check **names and
states** and classify by name, never by a rollup colour alone.

The read is **`pipeline-cli checks read`** — REST check-runs for the PR head, rolled up
latest-per-context. **Never `gh pr checks`.** That read is GraphQL-backed, and on PR #3988 it
reported 29 of 33 checks `IN_PROGRESS` across three consecutive reads while REST showed the same
checks `completed`/`success` 15+ minutes earlier — so a shipper following it literally burns the
full settle budget and then refuses a fully green PR
([#3999](https://github.com/kamp-us/phoenix/issues/3999)). That is the transport class this
suite's REST-only rule exists to avoid; the merge gate is the last place to reach past it. The
verb also owns the running/wedged split and the latest-per-context reduction — cite it, don't
re-derive the query (#3762).

```bash
# stdout: `CONTEXTS=<n>`, `RUNNING=<names>`, `WEDGED=<names>`, `GATING_RED=<names>` — the classifier
# input the branches below read. An empty RUNNING/WEDGED/GATING_RED is the all-green answer, so the
# lines are always printed; an unreadable head instead prints `refused — head CI unreadable …` plus
# `INTENT_UNCLEARED=<0|1>` and exits 0 (a successful decline). Read for `CONTEXTS=`, not the status.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3-rollup-bindings.sh <owner/repo> <pr number>
```

**Parser-held — keep that source line inside this section.** The script's `jq` rollup bindings
(`RUNNING`, `WEDGED`, `GATING_RED`, `CONTEXTS`) are a contract with
`packages/pipeline-cli/src/tools/checks/step3-contract.ts`: it
slices this `## Step 3 — ` section, **follows the source line above into the script**, and derives
branch 2's pending predicate from the bindings it finds there — which is what stops
`checks.unit.test.ts`'s executable branch mirror from hand-copying them (#4054). Rename a binding,
point it at a different rollup field, or move the block to a script this section does not source, and
the parse resolves **no** fields and the mirror reds. Unlike `UI_RE`/`UI_EXCLUDE_RE` above, nothing
here has to stay in the markdown — only its **reachability from this heading** is fixed (#4498).

Not every red check blocks a merge, and **this classification is ship-it's own** — it is
deliberately *not* the base branch's required-context set, and must never be derived from it.
(Whatever the platform requires is live, mutable state: read it off the base branch's ruleset
`required_status_checks` at the moment you need it, the same way the queue-regime reads below
do — never recall it from prose.) What ship-it binds is the SHA-bound merge gate: the
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

**An unfinished check is one of two different facts, and the read tells them apart.** `$RUNNING`
is genuinely in flight — it settles on its own, which is exactly what the settle poll waits for.
`$WEDGED` is **stranded in the queue**: `status: queued` with a `null` `started_at`, a run that
never starts without an operator lever. A `fanout-guard` job sat wedged for ~2.5h and blocked a
fully-green PR while every surface an agent reads said only "pending" (#3999). Both are pending
to the gate — a wedge is **never** green, and the classification below is unchanged in that
direction — but they get **different outcomes**: running is waited out, wedged is *reported*.

**Zero-run check suites are not pending.** The inert third-party suites (vercel, sentry,
cloudflare-workers-and-pages) sit `queued` with **no attached check runs** on every head. A suite
with no runs has no state to contribute, so it contributes none: the rollup names them in
`inertSuites` for the ledger and counts none of them toward pending. This is what makes PR
#3988's shape — 43 completed check-runs, three zero-run `queued` suites — classify **green**.

An **empty** check set (`$CONTEXTS == 0`) is ambiguous and must not be read as green on its face:
it is either "CI ran and every check passed" or "no run ever fired for this head." Disambiguate it against
the workflow runs GitHub actually recorded for the head SHA — **both reads fail safe toward
"do *not* nudge"** (the Step-3z remedy close→reopens a live PR; never do that on a guessed
absence):

```bash
# stdout: `HEAD_SHA=<40-hex>`, `NWF=<n>`, `NRUNS=<n>`. Both counts already carry their fail-safe
# substitute when the lookup itself failed, so the printed number is the one to branch on.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3-empty-checkset-probe.sh <owner/repo> <pr number>
```

Classify in this order (a `skipped` / `cancelled` conclusion is non-blocking — neither a failure
nor an in-flight wait — and the rollup already resolves each context to its **latest** run, so a
superseded red can't red a green head, #3762):

1. **Any *gating* check red** (`$GATING_RED` non-empty) → do **not**
   merge. Run `disarm_intent refuse || INTENT_UNCLEARED=1` (guard 6), then route it to the
   self-heal lane: invoke
   [`/heal-ci`](../heal-ci/SKILL.md) with this
   PR/run, then report the result (e.g. `routed to heal-ci`). `heal-ci` decides
   flake-vs-defect; you only refuse on a gating red and hand off — you still do not merge.
1b. **Else, the head reported no contexts at all (`$CONTEXTS == 0`)** → skip the poll and go
   straight to the empty-set disambiguation (branch 3 below). Waiting is pointless when nothing
   has reported: with zero contexts there is no check to settle, so a settle poll would burn the
   full budget and refuse with the wrong reason instead of surfacing the dropped trigger.
2. **Else, something is still unfinished — the pending *sets*, never the rollup colour**
   (`[ -n "$RUNNING$WEDGED" ]`) → **enter the bounded CI-settle
   poll** ([§below](#the-bounded-ci-settle-poll--never-a-silent-park-1928)). Do **not** report
   `checks pending` and park: that stop-path delegated resumption to a caller that may never fire,
   and because a decline is a *successful* outcome it left the PR green-but-unenqueued with **no**
   FAIL and **no** outcome comment — the silent stall of #1928. The bounded poll re-reads the checks
   on a fixed budget and **always** terminates in exactly one of two PR-visible outcomes: it reaches
   the enqueue (fall through to Step 3.5 → Step 4) the moment the gating suite goes green, or — if
   the budget is exhausted with a gating check still pending — it posts an explicit
   `refused — CI still pending after <budget>` outcome comment on the PR and stops. When what is
   unfinished is **wedged** rather than running, the poll refuses early with the distinct
   stranded-in-queue reason instead of waiting out a run that cannot start (§below).
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

**Branch 2 tests the pending sets, never the rollup's `.conclusion` — an informational red would
otherwise mask an unfinished gating check.** `.conclusion` is an *aggregate colour*, in which **red
wins over pending**, and `.failing` still carries the informational checks that the `$GATING_RED`
carve-out strips only afterwards. So a red `deploy (web)` / `cleanup (web, …)` next to an unfinished
gating check makes the head read `red`: branch 1 does not fire (no gating red), a colour-based
branch 2 would not fire either, and the head falls through to branch 4 — **enqueued with CI
unfinished**.
The sharp case is this step's own motivating state: a wedged `fanout-guard` plus a red `cleanup
(web, …)` would enqueue silently instead of producing the stranded-in-queue refusal — and Step 3z's
close→reopen nudge is documented below as a cause of exactly those `cleanup` reds, so the shipper
can manufacture the masking condition itself. `ci_settle_wait` already reads the sets (`.running` /
`.wedged`) and never the colour; the entry test must answer "is anything unfinished?" the same way
the poll does, or the two diverge and the gate fails open.

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
# Hand it the head Step 2 verified (`CURRENT_HEAD=` from the native-review fold) — the mid-settle
# head-move guard compares against it, so a guessed value re-opens the TOCTOU window it closes.
# stdout: a progress line per poll, then ONE terminal line — `gating checks settled green after …`
# (proceed to Step 3.5), `routed to heal-ci …`, or a `refused — …` — plus `INTENT_UNCLEARED=<0|1>`.
# Every disposition is a successful decline and exits 0: read the TERMINAL WORD, not the status.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3-ci-settle-wait.sh <owner/repo> <pr number> <CURRENT_HEAD>
```

The three returns are the **whole guarantee**: `0` reaches the enqueue, `2` routes a mid-wait red
to `heal-ci` (branch 1's disposition) **and stops the ship** — it never falls through to Step 3.5 →
Step 4 — and `1` posts the durable refusal and stops. Both non-zero returns `exit` the shipper; only
`0` proceeds to enqueue. There is **no fourth path** where the shipper leaves the pending-wait without
either enqueuing or landing a PR-visible outcome — the silent park of #1928 is structurally
unreachable, and a mid-wait gating-red can never slip through to the merge queue.

### Wedged is a diagnosis, not a wait — and the remedy stays the operator's lever

The poll's refusals are deliberately **three different facts, named differently**: the budget ran
out while checks were genuinely running; the head moved; or the remaining checks are **wedged** —
`queued` with no start time, stranded. Before #3999 all three read as "CI still pending," which is
what let a `fanout-guard` job sit wedged for ~2.5h behind a comment that told the next agent to
just wait longer. Naming the state is the fix: "stranded in queue" and "still running" are
different facts and must be distinguishable through the surfaces an agent reads.

**ship-it reports the wedge; it does not clear it.** The remedy — `POST
/actions/runs/<id>/cancel` then `POST /actions/runs/<id>/rerun` (a plain `rerun` on a still-queued
run returns 403) — is spelled out in the refusal comment, but ship-it does not run it, for two
reasons. First, **authority**: ship-it holds the single *merge* authority (ADR 0048), not a
CI-mutation authority; cancelling and re-running another workflow's runs is a different power, and
a merge gate that silently reruns CI to make itself pass is a gate that can launder a stuck
producer into a green. Second, **termination**: a wedge whose cause is a genuinely broken producer
would be cancel/rerun-looped forever by an automatic remedy, which is the same unbounded-retry
shape the Step-3z nudge is explicitly bounded against. So the wedge exits the same way every other
non-enqueue does — a durable, PR-visible outcome naming the state and the lever — and a human or
`heal-ci` pulls it.

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
# Hand it the `HEAD_SHA=` the empty-checkset probe printed — the nudge counts `reopened` events since
# THAT commit, so a guessed head would mis-count them and re-nudge a head already nudged once.
# stdout: one terminal line — `nudged (close→reopen) …`, `unverified (no runs fired …)`, or
# `refused (not the dropped-trigger state: …) — no nudge` — plus `INTENT_UNCLEARED=<0|1>`. All three
# are successful declines and exit 0; read the terminal word.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3z-dropped-trigger.sh <owner/repo> <pr number> <HEAD_SHA>
```

**The script asserts this branch itself, and a third terminal outcome is its refusal (#4830).** The
classification above is *prose*: it happens in your head, and if you reach Step 3z from any other
state the remedy would close→reopen a live PR and leave a durable comment claiming a dropped trigger
that never happened (PR #4816 — a head with 45 contexts and 33 runs, nudged anyway). So the script
re-derives `CONTEXTS` / `NWF` / `NRUNS` at the head instead of trusting the branch that called it,
and prints `refused (not the dropped-trigger state: CONTEXTS=<n> NWF=<n> NRUNS=<n>) — no nudge`
**without touching the PR** — no close→reopen, no comment — whenever the state does not hold. An
**unreadable** number refuses on the same line (`…=unreadable`): an unknown is never a confirmed
zero, which is the whole of the class this closes (#4482). A refusal here means the *dispatch* was
wrong, not the PR: re-read Step 3's branch list against the numbers the refusal names.

The nudge **never bypasses verification** — it only restores the *missing runs*. A nudged PR
is handed back to the normal gate on the next invocation; the merge still requires a
current-head PASS (Step 2), green gating checks (Step 3), **and** a commit-bound, all-`pass`
run-evidence bundle (Step 3.5, guard 2). The close→reopen re-triggers CI; it does not advance
the merge by itself. Like Step 3's red and Step 2's FAIL, all three Step 3z outcomes —
`nudged (close→reopen) …`, `unverified (no runs fired — nudge exhausted …)` and
`refused (not the dropped-trigger state: …) — no nudge` — are a **successful run that declines to
merge**, not an error.

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
# stdout: `HAS_PRODUCER=<n>`, plus the `guard 2 N/A …` line at 0. The NUMBER is the answer, and a 0
# is reached only on a CONFIRMED-empty lookup — an unread one degrades to the strict path, never here.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3_5-producer-preflight.sh <owner/repo>
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
# stdout: `HEAD_SHA=`, `RUN_ID=`, `ART_ID=`, `MANIFEST=`, `ART_FETCH_STATUS=`, `ART_FETCH_ERR=` — the
# six inputs the assertion below takes as arguments. `RUN_ID` / `ART_ID` are legitimately EMPTY on a
# genuine absence (that IS assertion 1b's input), so every line is printed unconditionally: an absent
# line would mean the fetch never ran. The bundle itself stays on disk under the per-run `mktemp -d`
# that `MANIFEST=` points into — the one piece of cross-step state a process boundary does not lose.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3_5-fetch-artifact.sh <owner/repo> <pr number>
```

Now assert the bundle, **failing closed** on each check — an unreachable upstream, a missing
bundle, an unreadable schema, a stale commit, or any failed check refuses the merge with a
*distinct* reason string; never a silent pass. Assertion 1 forks first: a transient fetch
failure (assertion 1a) is reported as unverified-transient and **must be checked before** the
genuine-absence case (1b), since a transport failure leaves the bundle fields empty:

```bash
# Hand it the six values the fetch printed, VERBATIM and in this order. They are positional because
# the fetch and the assertion are separate processes now, and an input that silently defaulted to
# empty here would read as "genuine absence" (assertion 1b) for a bundle that fetched fine — so each
# refuses when absent, except `ART_FETCH_ERR`, which is the transient cause text and may be empty.
# stdout: NOTHING when all four assertions hold — guard 2 cleared; otherwise the ONE `unverified (…)`
# / `run-evidence checks failed (…)` line plus `INTENT_UNCLEARED=<0|1>`, at exit 0 (a successful
# decline). Read the line, not the status.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3_5-assert-bundle.sh \
  <owner/repo> <pr number> <ART_FETCH_STATUS> <RUN_ID> <ART_ID> <MANIFEST> <HEAD_SHA> <ART_FETCH_ERR>
```

The five refusal reasons are **distinct and load-bearing** — each names *why* the bundle
didn't clear, so the report (and a human reading it) knows whether it's an upstream outage, a
missing producer run, a producer/consumer schema skew, a stale push, or a real failing check:

- `unverified (run-evidence artifact unreachable — transient upstream error, retried: <cause>)`
  — a GitHub 5xx / non-zip error body while fetching the run metadata or the artifact zip, still
  failing after retry+backoff (the #3716 fix). This is **UNKNOWN, not absent** — the bundle may be
  present; the transport failed. Distinct from "no bundle" precisely so a shipper (or a human) does
  not investigate a non-existent CI gap during an outage; a re-dispatch once GitHub recovers clears
  it. The `<cause>` is the last captured stderr / non-zip-payload detail, never `2>/dev/null`'d away.
- `unverified (no run-evidence bundle)` — reads **succeeded** but runs fired for this head with the
  run-evidence producer yielding no artifact / an empty manifest. (The *zero-runs* case — the head
  SHA had **no** workflow runs at all — is caught earlier in [Step 3z](#step-3z--the-dropped-trigger-state-zero-workflow-runs--bounded-nudge)
  with its own `no runs fired (dropped trigger)` reason + nudge, so it never reaches here as a
  misleading "no bundle.")
- `unverified (unsupported bundle schemaVersion: <v>)` — a schema major the gate can't read.
- `unverified (stale run-evidence bundle: commit <c> != head <h>)` — bundle isn't for this commit.
- `run-evidence checks failed (<names>)` — at least one `checks[]` entry is `fail` (or none present).

These five apply only when the repo **has** a run-evidence producer. When it does not, guard 2
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
> deleted/empty `manifest.json` (reads succeeded, producer yielded nothing) trips assertion 1b
> (`no run-evidence bundle`); a manifest with `schemaVersion: 2` trips assertion 2. Each refusal
> is distinct — no silent pass.
>
> **The 503-vs-absent distinction (AC #1, the #3716 reproduction).** The transient path is
> covered separately from the manifest assertions because it fires *before* a manifest exists.
> Reproduce the incident: write a 169-byte JSON 503 body where the zip is expected and confirm
> `is_zip` rejects it (magic `504b0304` mismatch) so `fetch_artifact_zip` returns transient — the
> gate reports `unverified (run-evidence artifact unreachable — transient upstream error, …)`, NOT
> `no run-evidence bundle`. The two live on opposite sides of the `ART_FETCH_STATUS` fork: a
> **listed** artifact (`ART_ID` non-empty) that will not download as a valid zip is `transient`
> (assertion 1a); an artifact the producer never emitted (`ART_ID` empty after a *successful* read)
> is `absent` (assertion 1b). `is_zip` on the passing bundle's real zip returns 0 — the positive
> case still clears.
>
> ```bash
> printf '{"message":"Server Error","documentation_url":"…"}' > "$RUN_SCRATCH/run-evidence.zip"
> is_zip "$RUN_SCRATCH/run-evidence.zip" && echo "BUG: JSON accepted as zip" || echo "OK: 503 body rejected → transient, not absent"
> ```

```bash
# build a passing + failing manifest from the tool fixtures, then run the four assertions
# against each (commit-mismatch and missing-bundle are the same passing manifest mutated):
cd packages/pipeline-cli/src/tools/crabbox-manifest
HEAD_SHA=deadbeef
RUN_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ship-it-rehearsal.XXXXXX")" || exit 1   # §SP rule 4: allocated + consumed in THIS block
node ../../bin.ts crabbox-manifest --run-summary <(node -e 'console.log(JSON.stringify(require("./fixtures.ts").passingRunSummary()))') \
  --commit "$HEAD_SHA" --environment test --output "$RUN_SCRATCH/pass.json"   # all checks pass → clears
node ../../bin.ts crabbox-manifest --run-summary <(node -e 'console.log(JSON.stringify(require("./fixtures.ts").failingRunSummary()))') \
  --commit "$HEAD_SHA" --environment test --output "$RUN_SCRATCH/fail.json"   # test exit 1 → assertion 4 refuses
# pass.json with commit != $HEAD_SHA → assertion 3 (stale); rm it → assertion 1
```

---

## Step 3.6 — Unresolved inline review threads gate: a bot's may be resolved, a human's never (ADR 0224, guard 3)

An inline review thread — human **or** bot — whose resolution state is **unresolved** is a
merge-blocking signal, on the same footing as a `review-*: FAIL` verdict. Before you enqueue,
read the PR's unresolved threads and act on them. The `review-*: PASS` verdicts (Step 2), the
green CI (Step 3), and the run-evidence bundle (Step 3.5) attest the diff against the issue's
acceptance criteria — they do **not** see an inline "fix this" a human (or the code-quality bot)
left on a line. That objection was silently discarded before merge (#2123, the broadened
root-cause parent of #2121: the bot's unused-import thread shipped past every gate on PR #2113).

**The ruleset flag is LIVE, so this step is defense-in-depth — and the only unparker.** The
`pull_request` rule on ruleset `17377992` (`main protection`, enforcement `active`) carries
`required_review_thread_resolution: true` — read live 2026-07-27, correcting ADR 0158's
`false (OFF)` + "founder-gated and NOT flipped by this skill". GitHub blocks enqueue on any
unresolved thread server-side; that platform gate is now **primary** and this step is the second
layer (ADR 0224 trusts the flag on the founder's judgment that the 2022 `gh pr merge --auto`
bypass is an edge case — the "definitive live test" ADR 0158 made a precondition for that trust
was **not** run). The corollary is why the resolve path below cannot simply be deleted: with the
flag on, a resolve here is the **only** mechanism in the pipeline that can clear a thread and let
a PR enqueue at all.

**The load-bearing crux (ADR
[0224](https://github.com/kamp-us/phoenix/blob/main/.decisions/0224-ship-it-resolves-bot-threads-never-human-threads.md),
amending ADR
[0158](https://github.com/kamp-us/phoenix/blob/main/.decisions/0158-unresolved-review-thread-is-a-merge-gate.md)
§Decision 3): author class is evaluated FIRST, and only a positive `Bot` derivation unlocks a
resolve.** A shipper that "resolves" a human's real objection just re-creates the throw-away one
layer down, so the substantive-vs-nit judgment is now **subordinate** to the class:

1. **Bot-authored** → ADR 0158 §Decision 3 applies unchanged: **substantive** refuses the ship
   like a FAIL; a **genuine nit** may be resolved **only with an explicit written rationale**;
   **in doubt, treat it as substantive**. This is where the lint-nit deadlock pressure is, and
   where the relief stays.
2. **Human-authored** → **always** refuse and route back. No nit exception, no in-doubt branch,
   no override: the class decides, and no flag, prompt, operator instruction, or judgment call
   moves a thread out of this branch.
3. **Class not derivable → the human branch.** Unknown is human.

This is a **whitelist, and reading it as anything else defeats it**: a positive `Bot` is
*sufficient* to unlock the resolve, and nothing is *necessary* to land in the refuse branch. A
GitHub App's review comments can surface as `Bot` **or** as `User` depending on the integration,
so never infer "human" from the absence of a signal — and never infer "bot" from a login suffix,
a name pattern, or an allowlist of known bots (ADR 0224 Banned). Rule 3 settles `Mannequin` /
`Organization` / a null author on a ghosted account **by construction rather than by
enumeration**.

### Reading resolution + author class — the one sanctioned GraphQL read (ADR 0158 §Decision 2)

Thread **resolution** state (`isResolved`) is a **GraphQL** field
(`repository.pullRequest.reviewThreads[].isResolved`); the REST inline-comments endpoint
(`GET /repos/{o}/{r}/pulls/{n}/comments`) exposes the comments but has **no** `isResolved` field
and no thread grouping, so it cannot tell resolved from unresolved. Reading review-thread
resolution is therefore the **single, narrow, documented exception** to this skill's REST-only
rule — verified working on this org (the Projects-classic breakage is scoped to Projects fields,
not `reviewThreads`; grounded live on PRs #2113/#2122/#2107, ADR 0158). Every other read/write in
this skill stays REST.

`author` is GitHub's `Actor` interface, so `__typename` — its concrete class — is the ADR-0224
discriminator, and it rides on the `author` selection this same read **already makes**. That is
**not** a second GraphQL call, and no other GraphQL is sanctioned anywhere in this skill.
Discrimination is live-verified on this org: `github-advanced-security` and
`copilot-pull-request-reviewer` return `Bot`, a human login returns `User` (#4408).

```bash
# stdout: one compact JSON object per UNRESOLVED thread (`{id, path, line, author, class, body}`).
# ZERO objects at exit 0 is the ordinary clean answer — no unresolved threads. A read that could not
# execute prints its two `STOP:` / refusal lines plus `INTENT_UNCLEARED=<0|1>` and exits 1, so the
# status is what tells "no threads" from "no answer": never read emptiness as clean.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3_6-threads-read.sh <owner/repo> <pr number>
```

### Disposition — class first, then (bot only) substantive-vs-nit

For **each** unresolved thread the derivation returns:

- **`class == "human"` — REFUSE, unconditionally.** Run `disarm_intent refuse || INTENT_UNCLEARED=1`
  (guard 6), then report `unresolved human-authored review thread (<path>:<line>, @<author>)` and
  stop — a FAIL-class refusal routed back to `write-code` to address the thread on the branch. Do
  **not** read the body, do **not** weigh substantive-vs-nit, do **not** resolve it. You have no
  authority to dismiss a person's objection, and an underivable class arrives here too — reported
  as `unresolved review thread, author class UNKNOWN (<path>:<line>)`.
- **`class == "bot"` and substantive** — a real objection: a finding that names a real defect (an
  unused import, a missing guard), or anything you cannot confidently call trivial. → **REFUSE**
  the same way, reporting `unresolved substantive review thread (<path>:<line>, @<author>)`.
- **`class == "bot"` and a genuine nit** — a trivial, already-satisfied, or obsolete note (a style
  preference already followed, a question already answered in the diff, a finding a later commit
  made moot). → you **may** resolve it, but **only with an explicit written rationale**: reply on
  the thread stating *why* it is a nit, then resolve it. Never a silent or blanket resolve — the
  rationale reply is the whole post-hoc audit trail.

If **any** unresolved thread is human-authored, underivable, or a substantive bot finding (or
in-doubt), you refuse — the whole PR does not enqueue. Only when **every** unresolved thread has
been either addressed on the branch (so it no longer shows unresolved) or resolved-with-rationale
as a bot nit do you proceed to Step 4.

```bash
# Resolve a NIT thread — ONLY on a thread whose class derived as `bot`, and ONLY after posting the
# rationale reply. Takes the thread's node id from the same read. REST cannot resolve a thread, so
# the resolve mutation is part of the same sanctioned GraphQL exception (ADR 0158).
# gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread { isResolved } } }' -F t="$THREAD_ID"
```

**Refuse in doubt.** A false route-back costs one cycle; a false auto-resolve silently discards a
real objection — the exact failure ADR 0158 closes, and narrowing by class is what makes the
misjudgment unable to reach a person's objection at all. Every underivable author becomes a
route-back, deliberately: the cost is round-trips, and that is the intended direction of the
error. This guard is **additive**: it layers a new pre-enqueue refusal on the existing sequence
(Step 0 §CP approval, Step 2/2b current-head PASS, Step 3 green CI, Step 3.5 run-evidence) and
weakens none of them.

> **`review-code`'s surfacing stays author-blind — decided, not overlooked.** ADR 0158 §Decision 4
> has `review-code` list every unresolved thread in its verdict table as a `[FAIL]` row, and ADR
> 0224 leaves that unchanged for both classes: surfacing is not dismissing, so making an objection
> *visible at the gate* is safe whoever wrote it, and splitting it by class would hide bot threads a
> human reviewer may well want to see.

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
# stdout: `LEAK_SCAN=clean` when guard 4 clears — a positive token, because this guard's clean answer
# is otherwise silence and silence is also what a scan that never ran looks like. A leak, or an
# unresolved shim, names itself on stderr, prints `INTENT_UNCLEARED=<0|1>`, and exits 1.
bash ./.claude/.pipeline/skills/ship-it/scripts/step3_7-leak-scan.sh <owner/repo> <pr number>
```

Refuse **fail-closed**, exactly like the other pre-enqueue guards: a non-zero `scan-pr` (a live leak)
STOPS the ship — you do not enqueue, you route to remediation (redact via `redact-leaks`, re-post
through `verdict post`, and repair the bypass). This guard is **additive**: it layers a new
pre-enqueue refusal on the existing sequence (Step 0 §CP approval, Step 2/2b current-head PASS, Step 3
green CI, Step 3.5 run-evidence, Step 3.6 inline threads by author class) and weakens none of them. It catches a
leaked comment **regardless of how it was emitted** — the property no emit-side guard can offer.

---

## Step 4 — Enqueue for squash-merge (auto-merge / merge queue)

Every guard cleared: not a control-plane PR without a current-head team approval (Step 0), the
required gates' latest verdicts are a current-head PASS (Step 2/2b), checks are green (Step 3),
the run-evidence bundle is present, commit-bound, and all-`pass` (Step 3.5), **every unresolved
inline review thread was a bot's and a nit** (Step 3.6, ADR 0224), and **no landed comment carries a
machine-local path** (Step 3.7, issue #3019). **Enqueue** it for a squash merge — the
merge queue owns the final merge, testing the prospective batched merge result against a fresh
base before it lands (ADR
[0132](https://github.com/kamp-us/phoenix/blob/main/.decisions/0132-merge-queue-for-base-freshness.md)):

```bash
gh pr merge $PR --auto
```

This is the **only** place a merge intent is ever armed (guard 6 / ADR 0198) — reaching it means
every guard above cleared at *this* head, which is exactly what makes the arm legitimate. It stays
armed only until the queue takes the PR; Step 5.5 clears it if the queue never does.

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
(resolved through `pipeline-cli merge-queue-classify` — **not** the `mergeQueueEntry` `--json`
field, which gh 2.62.0 rejects, #1930). See ADR 0132 addendum §3.

```bash
# stdout: the two PR-state objects, then `QUEUE_STATE=<merged|queued|pending|ejected>` — that last
# line is the answer. An unresolved shim prints no `QUEUE_STATE=` line, names itself, and exits 1:
# could-not-run is UNKNOWN, never a queue outcome.
bash ./.claude/.pipeline/skills/ship-it/scripts/step5-confirm-enqueued.sh <owner/repo> <pr number>
```

**Why the verb and not a `gh api …/timeline` one-liner here.** This confirmation used to
hand-roll its own timeline read, and that second copy diverged from the tool it duplicated in
two ways, each of which misreports a healthy enqueue (#4193):

- It read the timeline **un-paginated**, so it only ever saw the first 30 events. On PR #3955 —
  a 122-event timeline whose `added_to_merge_queue` sits past event 30 — it printed
  `no-merge-queue-event` while the PR was queued the whole time, and a shipper burned a run
  chasing an enqueue failure that never happened. The verb reads `?per_page=100` **with**
  `--paginate`. If you ever do need a raw timeline read, obey the contract's pagination rule
  ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), the `CONTROL_PLANE_RE`
  probe): `--paginate` composes only with a **streaming** `--jq` (`.[] | select(…)`), never an
  aggregate one (`map(…) | last`, `length`, `add`) — gh runs the filter **per page** and emits
  one result each, so an aggregate filter answers for page 1, then again for page 2, and a
  caller capturing it in `$( … )` gets a multi-line value it will compare as a single word.
- It printed the **last** merge-queue event raw, and `removed_from_merge_queue` is **not** an
  ejection signal on its own — the queue also emits it on a *successful* merge, at a timestamp
  matching `merged_at`. The verb ranks `merged` above that event, so a landed merge never reads
  as a dequeue.

Branch on `QUEUE_STATE`; **every** outcome has a defined response, so no value is a dead end:

- **`queued`** — confirmed in the queue. Step 5's success shape; report `enqueued: yes`.
- **`merged`** — the queue landed the batch inside this run. Terminal success.
- **`pending`** — no merge-queue event yet. This is the enqueue-**settle** window, **not** proof
  the enqueue failed, and never an ejection. Do **not** re-run Step 4 or re-arm auto-merge off a
  single `pending` — a re-drive is the wrong action on a PR that may already be queued. Fall
  through to Step 5.5, whose bounded reconcile polls this same verb; on a queue-governed base
  branch (every PR in this repo) a PR still `pending` at the budget's end is the **parked-intent**
  case guard 6 already owns — it clears the intent and the run reports `refused — the enqueue did
  not take effect at this head`. That is the sanctioned way a genuinely absent enqueue is acted
  on, and it is reached by waiting out the window, never by re-enqueuing here.
- **`ejected`** — the queue dropped the PR. Step 5.5's `ejected` branch owns the response.

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
events (`added_to_merge_queue` on enqueue, `removed_from_merge_queue` on a dequeue; GitHub
"Managing a merge queue") — **not** a momentary `mergeStateStatus`. A trailing
`removed_from_merge_queue` is an ejection **only when the PR is not merged**: the queue emits
the same event on a *successful* merge, at a timestamp matching `merged_at`, so it must always
be paired with `merged`/`merged_at` before concluding (the classifier does this by ranking
`merged` above it — #4193). The old discriminator
inferred `ejected` from `OPEN + mergeStateStatus != QUEUED`, but a freshly-enqueued PR reads
`mergeStateStatus = CLEAN` for a few seconds *before* GitHub flips it CLEAN → QUEUED, so a
genuinely-queued PR false-classified as `ejected` on the first poll (the #1906 live instance: an
ejection comment posted on a healthy queued PR, then retracted by hand — #1921). The fix adds a
fourth outcome, `pending` (the enqueue-settle window: OPEN, not merged, **no** merge-queue event
yet), which is **never** an ejection. The classification is a **pure, unit-tested** predicate in
`pipeline-cli merge-queue-classify` (`packages/pipeline-cli/src/tools/merge-queue-classify/`) — the
reconcile shells out to it per poll and branches on the printed outcome word:

```bash
# stdout: `MERGE_OUTCOME=<merged|queued|pending|ejected>`, `RECONCILE_HORIZON=<secs>`,
# `INTENT_UNCLEARED=<0|1>`, then `MERGE_DISPOSITION=<text>` last (it is the only multi-word value, so
# take the rest of that line verbatim into the ledger's `merge:` line). An unresolved shim prints
# none of them and exits 1 — a reconcile that never ran is UNKNOWN, not `pending`.
bash ./.claude/.pipeline/skills/ship-it/scripts/step5_5-reconcile.sh <owner/repo> <pr number>
```

**Parser-held — keep that source line inside this section.** The script's `RECONCILE_TRIES` /
`RECONCILE_SLEEP` defaults, its between-polls `sleep` guard, and its `MERGE_DISPOSITION` case arms
are a contract with `packages/pipeline-cli/src/tools/merge-queue-classify/step55-contract.ts`: it
slices this `### Step 5.5 — ` section, **follows the source line above into the script**, and derives
the observation horizon and the three disposition renderings from what it finds there — which is what
stops `step55-contract.unit.test.ts`'s executable reconcile mirror from hand-copying the budget
(#4403). Widen the budget, drop the between-polls sleep guard, or move the block to a script this
section does not source, and the parse resolves a **zero** horizon and the mirror reds.
Nothing here has to stay in the markdown — only its **reachability from this heading** is fixed
(#4498).

#### The loop is not the evidence — and a bare removal event is not an ejection (#4155)

The block above shells out to the classifier on purpose. When you are tempted to hand-roll the
poll instead — a `gh api` read piped into a `grep`, because the CLI was one step away — these three
rules bind that loop too. The first two are the merge-path instance of §WL of
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) (the shared statement; read it
there rather than re-deriving it here):

- **A wait-loop's exit is never evidence that the merge landed.** The loop decides *when* to
  re-read, never *what is true*. Merge evidence is **`merged_at` non-null PLUS a `merged` timeline
  event**, re-asserted after the loop exits. On an **open** PR `merge_commit_sha` is GitHub's
  throwaway test-merge commit and is evidence of nothing (the trap pinned below), and a null
  `auto_merge` post-enqueue is **expected** under a merge queue — never read either as an outcome.
- **Never `grep -qv` / `grep -vq` as the exit condition.** The live instance is this step: a
  shipper's improvised `grep -qv null` poll over a multi-field read succeeded on poll 1 — every such
  read emits lines without `null` — and the loop exited while PR #4076 was still queued (#4155).
  Capture the inverted match and test emptiness instead.
- **`removed_from_merge_queue` alone is not an ejection.** The queue emits that event as it
  **consumes** the entry to land the batch, so on a successful merge it pairs with a `merged` event
  ≤1s away — PR #4076 (removal `00:27:43Z`, merged `00:27:44Z`), #4143 (both `00:53:07Z`, with
  `merged` returned *first* in the array), #4164 (`01:38:30Z` / `01:38:31Z`). Array order and
  timestamp order discriminate nothing; the **presence of the `merged` event** does.
  `merge-queue-classify` encodes exactly this — a removal paired with a `merged` event classifies
  `queued`, never `ejected`, and does **not** promote to `merged` on that one signal (merge evidence
  is still `merged_at` plus the event, so the reconcile keeps polling until the PR state or the
  base-branch squash confirms). An ejection check keyed on the removal alone would report **every**
  successful merge as an ejection.

#### The timeline is authoritative but not timely — the freshness cross-check and the ejection window this reconcile accepts (#4057)

During the #4011 ship the merge landed at `20:06:39Z` and, for the next ~65 minutes, `pulls/4011`
kept returning `merged:false` / `state:open` while the issue timeline kept ending at
`added_to_merge_queue`. The classifier read both faithfully and printed `queued` on 15 consecutive
polls after the PR had already merged. Two consequences follow — one closed, one accepted:

- **Closed — a stale `queued` on an already-merged PR.** The base branch stayed current through
  that whole window, so the classifier corroborates a non-merged read against it: a **single-parent
  commit reachable from the base branch whose subject ends with `(#PR)`** is this PR's squash, and
  it classifies `merged` whatever the PR-state and timeline reads say. The scan window is the base
  branch's most recent 100 commits. An absent or unreadable base-branch read carries **no**
  evidence and never moves the verdict, so the fail-closed posture is untouched.
- **Accepted — a not-yet-surfaced *ejection*.** `removed_from_merge_queue` is the only ejection
  signal REST exposes, and the base-branch cross-check cannot substitute for it: an ejected PR and
  a healthy queued one are identical in every REST read (open, not merged, last event
  `added_to_merge_queue`, no squash on the base). The read that would tell them apart — the queue's
  own entries — is **GraphQL-only**, which this org bans (top of this skill). So the residual is
  accepted, with this bound: **while the timeline lags — ~60 minutes observed, unbounded in
  principle — an ejected PR classifies `queued`.** What contains it is not over-reading that word.
  A terminal `queued` means *still in-flight as far as the timeline can tell*, never *healthy,
  never ejected*: it is not reported as shipped, guard 6 leaves an arm only where a live queue
  entry exists, and the ejection surfaces on any later read once the timeline catches up — a
  re-dispatched ship-it, or the driving loop's next pass over the PR.

**The adjacent trap, pinned:** on an **open** PR, `merge_commit_sha` holds GitHub's throwaway
*test-merge* commit and is evidence of nothing — PR #4011 carried `8dd72534…` there for an hour
while unmerged. The load-bearing merge signals are `merged` / `merged_at`, plus the single-parent
squash on the base branch. Never read a non-null `merge_commit_sha` as "it merged", and never
cross-check it against the base tip.

Then act on `MERGE_OUTCOME`, and only here — **never at Step 4's enqueue** — decide the run's
merge disposition:

- **`merged`** — the queue landed the batch. Terminal success; the `Fixes #N` close has fired (or
  is firing) async. Report `merged: yes (queue landed the batch)`.
- **`queued`** / **`pending`** — the PR is still healthily in-flight at the window's end: `queued`
  is confirmed in the queue (last event `added_to_merge_queue`, or `mergeStateStatus == QUEUED`);
  `pending` is the **enqueue-settle window** (OPEN, not merged, no merge-queue event yet — incl.
  OPEN + CLEAN before the CLEAN → QUEUED flip). **Both are a well-formed pending, not a failure**
  (ADR 0132: the actor does not block to the final merge). But it is also **not a settled outcome**:
  the run watched a bounded slice of a dwell it did not see the end of, so the merge is **UNRESOLVED
  — genuinely unknown, and it may well land seconds later**. Report the disposition the `case` block
  above rendered, verbatim, **carrying `$RECONCILE_HORIZON`** — the run states how long it watched
  and that landing is unconfirmed, never a settled disposition. Two words are banned here because
  each asserts more than any expired reconcile observed: **"reconciled"** (the window closed on an
  answer — it did not) and **"auto-merges on green"** (a future stated as fact). The distinction
  they erased is the one this bullet turns on: still-queued at the horizon means **still in-flight
  as far as the timeline can tell**, which is not "never ejected" (the accepted staleness bound
  above) and is not "it will merge". A `pending` PR at the budget's end is reported this way too — the settle window
  is **never** an ejection (#1921). **One carve-out** (guard 6): on a base branch a **merge queue
  governs** — every PR in this repo — a `pending` PR never entered the queue at all, so what it
  carries is a parked intent, not an in-flight enqueue; the guard-6 block above clears it and the
  run reports `refused — the enqueue did not take effect at this head` instead. Only where the base
  branch has **no** merge queue does the arm stay (the pre-queue regime, where `--auto` *is* the
  enqueue mechanism) and get reported as the well-formed pending above. The predicate is the
  branch's regime, never this PR's own queue history: a first-attempt PR under a queue has no
  history either, so keying on history would leave exactly the #3700 arm parked.
- **`ejected`** — the queue **dropped** the PR (still open, no longer queued, not merged) — keyed on
  the authoritative `removed_from_merge_queue` timeline event **unpaired with a `merged` event**
  (#4155), not on a momentary state. This is
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
  loop on the same unmerged batch conflict) — **and, under guard 6, it leaves no arm that could
  re-enqueue it either**: the ejected PR's intent is cleared above, so the eject → rebase →
  re-review → re-approve cycle re-enters the queue only through a fresh ship-it gate pass, never on
  the re-approval alone (ADR 0198). The ejection is surfaced and handed to the repair /
  re-queue lane (the `drive-issue.js` shipper stage consumes `ejected` and re-drives), the same
  fail → fix → re-request boundary write-code owns. The **success/watch distinction is now
  observable** — a surfaced ejection never masks as a ship, because the reconcile separated `merged`
  from `queued`/`pending` from `ejected` off the authoritative merge-queue timeline event, so an
  enqueue-settle window no longer masquerades as an ejection (#1921) and a lagging timeline no
  longer holds a landed merge at `queued` (#4057). An ejection the timeline has not yet surfaced is
  the one residual, bounded above.

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
# Hand it the linked issue Step 1 resolved. stdout: one line, `RELEASE_QUEUE=queued (awaiting human
# flip)` or `RELEASE_QUEUE=n/a (not a dark ship)` — the ledger value. No linked issue ⇒ nothing to
# queue ⇒ the `n/a` no-op, unchanged.
bash ./.claude/.pipeline/skills/ship-it/scripts/step5b-release-queue.sh <owner/repo> <pr number> <linked issue>
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
observed to `landed` or left UNRESOLVED at the reconcile's horizon** (never a silent ejection, and
never a bounded observation dressed as a settled one — #4403), and the issue-close is async
(ADR 0132).

Report back a tight terminal ledger — nothing else, because the merge itself is the
durable record:

```
PR #<PR> — issue #<ISSUE>
branch: <head ref>
PR url: <html_url>
enqueued: yes (QUEUED — the queue owns the async merge) | no (<reason if no>)
merge: <the MERGE_DISPOSITION Step 5.5's case block rendered — landed | UNRESOLVED … ~<N>s … may still land | EJECTED>
issue: closes async on queue merge | n/a (doc/vocab-surface-only, no linked issue) | #<PART_OF> left open (partial split)
release: queued (awaiting human flip) | n/a (not a dark ship)
```

The `enqueued:` line is the enqueue success condition: `yes (QUEUED — the queue owns the async
merge)` once `--auto` armed the merge (Step 4). It reports that the PR entered the queue, never
that it will come out of it merged. The `merge:` line is the reconcile's terminal outcome (Step
5.5) — the queue owns the final, async merge, so the issue-close also lands async (ADR 0132),
reported as `issue: closes async on queue merge`. There is no in-run `merged: yes` / `issue closed:
yes` **assertion** any more — asserting an immediate merge would false-fail every enqueued PR — but
the bounded reconcile **does** distinguish `landed` from `UNRESOLVED (still queued)` from
`EJECTED`, so `QUEUED` never masks a silent stall. An `EJECTED` outcome is **not** a shipped state:
it routes back to repair/re-queue (Step 5.5), never reported as success. An **UNRESOLVED** outcome
is not a shipped state either — but it is equally **not a failure**: it says the observation ended
at its horizon with the PR still queued, and the merge may still land. Never read it as "it did not
merge" (#4403).

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
re-dispatch on the now-green head enqueues cleanly), `refused — CI wedged (stranded in queue:
<names>)` (the unfinished checks are `queued` with no start time and will not start on their own,
so the poll refuses with the distinct diagnosis and the cancel-then-rerun lever rather than
waiting the budget out — Step 3, #3999), `refused — head CI unreadable (typed unknown)` (the
check-runs read returned nothing interpretable; an unreadable head is never a green head — #3999),
the dropped-trigger outcomes (Step 3z):
`nudged (close→reopen) — CI re-triggered, not yet merge-ready` (the head SHA had zero workflow
runs; ship-it close→reopened it once to re-emit the trigger, posted a durable PR outcome comment,
and stopped — re-dispatch after CI settles), `unverified (no runs fired — nudge exhausted,
producer may be stuck)` (already nudged once and still zero runs → handed to a human, with a
durable PR outcome comment) or `refused (not the dropped-trigger state: CONTEXTS=<n> NWF=<n>
NRUNS=<n>) — no nudge` (the remedy was reached from a head that is not in the state it remedies, or
one of those numbers was unreadable — the PR is left untouched, #4830), `no linked issue`, or a
run-evidence refusal (Step 3.5):
`unverified (run-evidence artifact unreachable — transient upstream error, …)`,
`unverified (no run-evidence bundle)`, `unverified (unsupported bundle schemaVersion: <v>)`,
`unverified (stale run-evidence bundle: …)`, or `run-evidence checks failed (<names>)`. A
refusal is a successful run — shipping the wrong PR is the only failure mode that matters.

**A refusal carries one more fact: the merge intent is clear.** Every reason above is reported by a
path that ran `disarm_intent refuse` (guard 6), so a refused PR cannot enqueue on the next approval
without a fresh ship-it run. If a disarm ever failed (`INTENT_UNCLEARED=1`), append
`merge intent: NOT cleared — auto-merge may still be armed, disable it by hand` to the ledger —
never report a clean stop over an armed intent (ADR 0198).

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
