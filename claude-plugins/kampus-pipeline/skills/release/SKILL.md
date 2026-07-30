---
name: release
description: >-
  The human release act made one guarded command — release a dark-shipped feature end to end without ever touching the Cloudflare dashboard. Given a flag key, run the guarded release ritual: pre-flight the flag's effective serving via anka-ops and confirm it is currently dark, refuse the flip when the flag's user-facing slice is unreachable via pipeline-cli reachability-guard (no consuming UI / no registered journey e2e, ADR 0173), flip it live through anka-ops' 100%-no-match-split lever (dry-run → --execute), post-flight verify the flip took (dark → live), clear status:awaiting-release on the linked issue, and emit a human-readable release note. Supports `/release <flag-key> --percent <n>` for a ramped release. HUMAN-ONLY — an autonomous agent invoking it is hard-refused, the same enforcement shape as ship-it refusing to self-merge a control-plane PR (ADR 0053). Trigger on "release <flag-key>", "flip <flag-key> live", "release the dark feature", "/release". This is the human half of the agents-deploy / humans-release boundary (ADR 0083); the deploy is the agent's autonomous merge, the flip is yours.
---

# release

You are the human at the release lever. A feature was **deployed dark** — merged to `main`
and live in production behind a default-off Flagship flag, contained and invisible to users
until someone deliberately flips it (ADR
[0083](https://github.com/kamp-us/phoenix/blob/main/.decisions/0083-agents-deploy-humans-release.md):
*agents deploy, humans release*). This skill is that flip, made **one guarded command** so the
release act is a reviewable, verified ritual instead of an untraceable click in the Cloudflare
dashboard. You run the steps below end to end — pre-flight, the reachability gate (refuse the flip
if the flag's user-facing slice is unbuilt, ADR 0173), flip, post-flight verify, clear the queue
label, emit the release note — and you never open the dashboard.

The tool under every read and write here is **`@kampus/anka-ops`** — the operator CLI whose `flag`
verb group is the human-operated Flagship read/flip surface (`packages/anka-ops`, ADR
[0081](https://github.com/kamp-us/phoenix/blob/main/.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)).
It models the release the way it is actually performed: as a **no-match percentage split** (a
conditions-empty rule serving `on` to N% of traffic), **never** a `defaultVariation` flip. Read
its [README](https://github.com/kamp-us/phoenix/blob/main/packages/anka-ops/README.md) for the
full command surface; this skill is the *release ritual* that composes those commands, not a
second copy of them.

## HUMAN-ONLY — an autonomous agent MUST hard-refuse (guard 0)

**Release authority is the human flip.** This skill performs the one act ADR 0083 §1 reserves
to a human: making a dark feature visible to users. An **autonomous agent** reaching for
`/release` is a control-plane boundary violation, not a convenience — exactly as an agent
reaching to self-merge a control-plane PR is (ADR
[0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)).
So the first thing this skill does, **before any read, flip, or label write**, is refuse when
the caller is not a human at a keyboard:

- **If you are an autonomous agent** (a pipeline subagent, a Workflow task, any non-interactive
  invocation), **hard-refuse and stop.** Do not pre-flight, do not dry-run, do not flip. Emit
  the refusal and halt — the identical enforcement shape as `ship-it` Step 0 refusing to
  auto-merge a `.claude`/`.github`/gate-critical PR: a structural boundary the pipeline never
  routes around, never a soft warning it proceeds past.

  > **release: REFUSED — human-only.** `/release` performs the human release act (ADR 0083 §1:
  > agents deploy, humans release). An autonomous agent flipping a flag live is a control-plane
  > boundary violation (ADR 0053), the same class as self-merging a control-plane PR. The flag
  > stays dark. A human runs this command; the agent's boundary ended at the dark deploy.

- **If you are Claude Code driving an interactive human session** and a human typed `/release`
  (or asked you to run it), you are their hands at the lever — proceed through the ritual. The
  human is the release authority; you execute their explicit release on their behalf. This is
  the *only* sanctioned path past this guard.

The refusal is **fail-closed**: absent positive evidence that a human is driving this
invocation, refuse. An unattended drain, a spawned coder, a scheduled job — none of them are the
human this boundary reserves the act for. This guard is the skill's load-bearing invariant, not
advice: a `/release` that flips without a human at the keyboard has dismantled the ADR-0083
boundary the whole dark-ship discipline rests on.

---

## Preconditions — credentials + the flag key

You need two things before the ritual:

1. **Cloudflare credentials resolvable by anka-ops.** `anka-ops` reads `$CLOUDFLARE_API_TOKEN` +
   `$CLOUDFLARE_ACCOUNT_ID` from the environment, or the macOS Keychain once you've run
   `anka-ops auth login` (#1730 — the keychain-backed credential store, so the ritual never opens
   with "export your API token"). Confirm they resolve and actually authenticate before you
   touch a flag:

   ```bash
   cd packages/anka-ops
   node src/bin.ts auth status   # reports where each credential resolves from and whether it authenticates
   ```

   If `auth status` reports the effective resolution does **not** authenticate, run
   `node src/bin.ts auth login` (prompts for the token + account id, validates them against an
   authenticated read **before** persisting, stores both in the Keychain) and re-check. Do not
   proceed on unauthenticated credentials — every step below would fail mid-ritual.

2. **The flag key + target env.** The command is `/release <flag-key>` — a kebab-case Flagship
   key (`<product>-<feature>-<purpose>`, e.g. `phoenix-bildirim`). The release target is the
   **`prod` env** by default (the release act is a production flip); pass `--env <env>`
   explicitly only to release into a non-prod env. Resolve them once:

   ```bash
   FLAG_KEY="<the kebab-case flag key>"
   ENV="prod"   # override only with an explicit --env
   ```

Resolve `$REPO` the same way the rest of the pipeline does (it is repo-agnostic; ADR 0062):

```bash
REPO="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/resolve-repo.sh")" || exit 1
```

All GitHub reads/writes below go through **`gh api` REST** — never GraphQL (the org's
Projects-classic integration errors GraphQL issue/PR queries, the standing pipeline constraint).

## The extracted scripts

This ritual's shell lives in [`scripts/`](scripts/), one script per step, and each fenced block
below is an **invocation** of one. The prose keeps the *why*; the scripts hold the *how* (epic #4435
phase 1 — the shell moved as-is, and turning its `gh`/`jq` glue into tested `pipeline-cli` verbs is
#1929). Four properties are load-bearing when you read or edit them:

- **They set `set -uo pipefail`, deliberately not `-e`.** The moved glue steers its own control
  flow — the reachability refusal, a delete that may legitimately 404, a search whose zero-match
  result is an answer. `errexit` would abort a fail-closed branch before it printed its refusal.
- **The dry-run and the apply are two separate scripts.** The two-step is the whole safety of the
  flip, so `--execute` lives only in [`scripts/flag-open-execute.sh`](scripts/flag-open-execute.sh)
  and can never arrive as a defaulted flag on the script that prints the diff.
- **Zero matches is its own exit code.** [`scripts/find-linked-issue.sh`](scripts/find-linked-issue.sh)
  exits **4** on a *proven* empty release queue and 1/2 when it could not run, so a failed read can
  never be read as "no queue entry to clear" and silently skip Step 4.
- **`packages/anka-ops` is resolved from the repo root, not the caller's cwd.** The moved blocks
  each opened with a bare `cd packages/anka-ops`; [`scripts/lib.sh`](scripts/lib.sh) resolves it
  from the git root and fails closed when the package is absent, so the flag lever can never run in
  the wrong tree.

---

## Step 1 — Pre-flight: read the effective serving, confirm it is dark

Read the flag's **effective serving** — what the env *actually serves* today, resolved through
rules → no-match split → default — and confirm the flag is currently **dark** before you flip
anything. `flag get` reports it in the canonical form (`off (default)` for an unreleased flag,
`on@100% (split)` for a released one, `on@N% (ramping)` for a partial):

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/flag-get.sh" "$FLAG_KEY" "$ENV"
```

- **Currently `off (default)` (dark) →** this is a release you can perform: proceed to Step 2.
- **Already `on@100% (split)` (fully live) →** there is nothing to release. **Stop** and report
  it — re-flipping a live flag is a no-op, and the queue label (Step 4) was almost certainly
  already cleared. This keeps the ritual **idempotent**: `/release` on an already-live flag is a
  clean no-op, not a double-flip.
- **Already `on@N% (ramping)` at a *lower* percent than you intend →** this is a **ramp-up**, not
  a first release; continue to Step 2 with the higher `--percent` (the ramp form below). Flipping
  to a lower or equal percent is a no-op — stop and report.
- **`FlagEnvNotFound` / not-found →** the key or env is wrong; fix the input and re-read. Do not
  proceed against a flag anka-ops can't resolve.

Also resolve the **linked issue** now — you'll need it for Steps 4 and 5, and confirming it
exists up front means the ritual never flips a flag it can't then dequeue. The dark ship was
queued by `ship-it` as `status:awaiting-release` on the merged PR's linked issue, and the flag
key rides the PR body's `Flag: <key>` line (ship-it Step 5b). Find the awaiting-release issue
whose closing PR dark-shipped **this** flag key:

```bash
# prints one `match: issue #<I> ← PR #<P> declares Flag: <key>` line per match
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/find-linked-issue.sh" "$FLAG_KEY"
# LINKED_ISSUE is the awaiting-release issue whose closing PR body carried `Flag: $FLAG_KEY`.
LINKED_ISSUE="<that issue number>"
```

If no `status:awaiting-release` issue names this flag (**exit 4** — a proven-empty queue), or the
match is ambiguous (more than one `match:` line), **ask the human to confirm the issue number** (or
confirm there is no queue entry to clear) rather than guessing — a wrong dequeue clears another
feature's queue entry. Never silently skip Step 4. Any **other** non-zero exit means the search
never ran: that is UNKNOWN, not an empty queue, and it also goes to the human.

---

## Step 1.5 — Reachability gate: refuse the flip unless the flag's UI slice is reachable (ADR 0173)

Between resolving the flag (Step 1) and flipping it (Step 2), assert the flag's vertical is
**reachable**: a user-facing flag graduates to 100% (or ramps) only once a **consuming UI** and a
**registered journey e2e** exist for its key. This closes the "graduate a flag nothing consumes"
gap — reactions reached 100% in prod with **zero `.tsx` consuming `PHOENIX_REACTIONS`**, caught
only when a human happened to notice (ADR
[0173](https://github.com/kamp-us/phoenix/blob/main/.decisions/0173-vertical-completeness-gate.md),
epic [#1943](https://github.com/kamp-us/phoenix/issues/1943)). The gate converts "someone happens
to notice an unreachable feature" into "the release path structurally won't flip one."

The check is the **one shared `reachability-guard` contract** `plan-epic` also keys off — never a
second, drifting notion of "reachable" (ADR 0173 §1). Given `$FLAG_KEY` it asserts both a
consuming `apps/web/src/**/*.tsx` reference to the flag-key constant and a `@journey:$FLAG_KEY`-tagged
spec under `apps/web/tests/e2e/`, and **fails closed** (non-zero exit) naming exactly what's
missing. Run it for the resolved key **before the dry-run flip**:

```bash
# HARD-REFUSE the flip on a non-zero exit — the script relays the guard's report (on stderr), which
# names which assertion failed, then prints the refusal. The flag stays dark; do NOT proceed to
# Step 2.
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/reachability-gate.sh" "$FLAG_KEY" || exit 1
```

- **Non-zero exit → hard-refuse the flip.** This is the identical fail-closed refusal shape as
  the skill's guard-0 human-only refusal and the Step-3 post-flight verify-before-record stop —
  a structural boundary the ritual never routes around, never a soft warning it proceeds past.
  The flag stays dark; the human builds the missing user-facing slice first, then re-runs
  `/release`.
- **Exit 0 → reachable *or* exempt → proceed to Step 2.** A legitimately UI-less
  infra/containment flag (e.g. `pano-feed-edge-cache`, `PANO_FEED_EDGE_CACHE` — ADR 0170) passes
  here **because it carries a `@reachability-exempt: <reason>` marker at its `keys.ts`
  definition** (ADR 0173 §3). The refusal targets unreachable **user-facing** flags only; it
  never blocks a stated-exempt infra flag.

This gate is a check **the human's `/release` run** performs — it slots *after* guard 0, so a
human is already at the lever (ADR 0083); it adds a precondition to the flip, it does **not** make
`/release` autonomous. `reachability-guard` proves *presence* (a consuming reference + a
registered e2e exist), not correctness — a stub consumer or an empty journey spec passes; the gate
makes the zero-UI graduation unrepresentable, not the shallow-UI one.

---

## Step 2 — Flip: the 100%-no-match-split lever, dry-run then `--execute`

The flip is an `anka-ops flag open` write on the **canonical 100%-no-match-split form** (a bare
`flag open` ≡ `--percent 100`) — the *same* lever the release is actually performed with,
**never** a `defaultVariation` write (`defaultVariation` stays at its create-time safe value
forever; only the `flag close` kill switch touches it, and this skill never issues `close`).

**Always dry-run first.** `flag open` is **dry-run by default**: it reads current state, prints
the `current → target` diff, and writes **nothing** unless you add `--execute`. Read the diff and
confirm it flips *this* flag in *this* env from the dark state you saw in Step 1 to the intended
live state:

```bash
# Full release (100% — the default release act). DRY-RUN: prints current → target, writes nothing.
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/flag-open-dryrun.sh" "$FLAG_KEY" "$ENV"

# Ramped release (serve `on` to N% of traffic; the remainder falls to the safe default). DRY-RUN.
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/flag-open-dryrun.sh" "$FLAG_KEY" "$ENV" "$N"
```

Once the dry-run diff is exactly the release you intend, **execute it** by re-running the same
command with `--execute`:

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/flag-open-execute.sh" "$FLAG_KEY" "$ENV"        # APPLY the full release
# or, for a ramp:
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/flag-open-execute.sh" "$FLAG_KEY" "$ENV" "$N"
```

**`--percent <n>` — the ramped-release form.** `/release <flag-key> --percent 50` runs the
identical ritual but flips to a **no-match split serving `on` to N%** of traffic instead of 100%,
using anka-ops' `flag open --percent` ramp lever (#1726). Everything else is unchanged: pre-flight read, dry-run →
`--execute`, post-flight verify, clear the label, release note. A ramp is still a release — the
feature becomes visible to N% of users — so it clears the queue label and emits a release note
the same as a full flip, with the percent recorded in the note. (A later ramp-up to a higher
percent re-runs `/release <flag-key> --percent <higher>`; the label is already cleared, so
Step 4 is a no-op on the ramp-up, which is correct.)

**The two-step is the safety.** The dry-run makes an accidental prod release *unrepresentable* —
the mutation happens only under the explicit `--execute`, mirroring `orphan-sweep`. Never skip
straight to `--execute`: read the diff, then apply.

---

## Step 3 — Post-flight: re-read effective serving, confirm the flip took (dark → live)

A flip you didn't verify is a flip you can't trust. Re-read the **effective serving** and confirm
it now reports the live state — the dark → live transition actually landed:

```bash
# expect: on@100% (split)  — or  on@N% (ramping) for a ramp
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/flag-get.sh" "$FLAG_KEY" "$ENV"
```

Assert the transition:

- A full release must now read **`on@100% (split)`** (was `off (default)` in Step 1).
- A `--percent N` ramp must now read **`on@N% (ramping)`** at the N you flipped to.

If the post-flight read does **not** show the expected live state, the release **did not take** —
do **not** clear the queue label or emit a "released" note. Surface the discrepancy (what you
expected vs. what `flag get` reports), and stop so a human can investigate; a half-applied flip
left recorded as released is worse than an obvious failure. Optionally cross-check by hitting the
flag's evaluate path if one is available, but the effective-serving re-read is the authoritative
confirmation anka-ops gives you.

Only once the post-flight read confirms **dark → live** do you proceed to Steps 4 and 5.

---

## Step 4 — Clear the release-queue label on the linked issue

The feature is now live, so it is no longer *awaiting* release — clear `status:awaiting-release`
from the linked issue you resolved in Step 1. This is the queue's **consume** step (#602): an
infra-admin lists the queue with one filter, releases, then clears the label. `/release` does the
clear for you so the label doesn't rot (8 stale labels sat on already-released issues before being
hand-cleared the night this skill was proposed):

```bash
# remove the release-queue label from the (closed) linked issue — the consume half of #602
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/clear-queue-label.sh" "$LINKED_ISSUE"
```

The label lives on a **closed** issue (the dark ship's PR closed it on merge); removing a label
from a closed issue is fine and expected — the label is a post-merge *release* state, orthogonal
to the `status:*` pickability spine. If the issue no longer carries the label (a prior partial
run, or ship-it never queued it), the delete is a harmless no-op — the ritual stays idempotent.

---

## Step 5 — Emit the human-readable release note

The queue label is a machine state; a **release note** is the human-readable record of what just
went live — the artifact demanded by #1354 (dark-ship flags need a readable release note, not
just the awaiting-release queue). Emit it as the final act of the ritual: a short, glanceable
note naming the feature, the flag, the flip, and the linked issue. Post it as a comment on the
linked issue so it is durable and discoverable next to the work it releases (and surface the same
text to the human running the command):

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/release/scripts/post-release-note.sh" \
  "$LINKED_ISSUE" "$FLAG_KEY" "$ENV" "$SERVING_NOW" "<human releaser>"
```

`$SERVING_NOW` is the exact effective-serving string Step 3 confirmed (`on@100% (split)` or
`on@N% (ramping)`), so the note records the true post-flip state, not an assumed one. Keep the
note scannable — feature, flag, the dark → live transition, who released it, and the issue it
dequeues. This is the record a later `what-shipped` readout and any human auditing the release
queue reads to answer "what went live, when, and by whose flip."

---

## The ritual is done — no gate, no merge, nothing further

`/release` ends at the release note. There is **no PR, no review gate, no merge** — this is not a
code change, it is a runtime flip of production serving state performed by a human. Do not queue
anything, do not spawn a follow-up, do not re-flip. The five steps — pre-flight → flip →
post-flight verify → clear the label → release note — are the whole act.

If any step failed (unauthenticated credentials, a not-found flag, a post-flight read that didn't
confirm the flip), **stop at the failure and surface it** — never proceed to clear the label or
emit a "released" note on an unverified flip. A release that half-applied and was recorded as
complete is the failure mode this ritual's verify-before-record ordering exists to prevent.
