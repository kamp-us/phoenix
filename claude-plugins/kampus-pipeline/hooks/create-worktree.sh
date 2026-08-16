#!/usr/bin/env bash
# WorktreeCreate hook: provision an isolation:worktree by running `git worktree add`
# OURSELVES, so the ~13s bootstrap-deps `pnpm install` gets the hook's 600s timeout
# budget instead of racing the harness default-worktree-path's ~13s readiness limit
# (the non-deterministic fall-back-to-primary of #2924/#2923). See ADR 0178.
#
# Contract (Claude Code WorktreeCreate mechanism) — grounded in a CAPTURED REAL payload
# (ADR 0180), not the incomplete docs that produced #2925:
#  * stdin  — a JSON payload:
#        { session_id, transcript_path, cwd, prompt_id, agent_type, hook_event_name, name }
#      It carries `cwd` (the repo root) + `name` (the worktree id, `agent-<hex>`); the
#      worktree path is CONSTRUCTED as `<cwd>/.claude/worktrees/<name>`. The payload does
#      NOT carry `worktree_path` or `base_ref` — #2925 shipped a hook built to those inferred
#      fields and fail-closed on EVERY worktree spawn crew-wide (the golden fixture +
#      create-worktree.hook.test.ts now assert the captured shape so that can't recur).
#  * stdout — ON SUCCESS, ONLY the resulting worktree path (Claude Code adopts it).
#  * exit   — 0 on success; NON-ZERO on ANY failure. A non-zero WorktreeCreate ABORTS the
#             spawn — the harness rethrows and never falls back to its own provisioning
#             (verified against the harness's agent-worktree creator, see #4180 below), so
#             the coder never lands in a silently dep-less or primary-checkout tree.
#
# `git worktree add` fires the existing lefthook post-checkout `bootstrap-deps` install
# (ADR 0109) — we REUSE it, never reimplement it, so 0109's provision-not-share
# correctness is preserved unchanged.
#
# RUNTIME REALITY (#4180): on the harness path that provisions `isolation:worktree` agent
# trees, this hook is NOT being invoked at all. The harness's creator takes the hook only
# when its `hasWorktreeCreateHook()` predicate is true and otherwise provisions internally,
# on a `worktree-<name>` branch; every registered agent tree on this checkout carries that
# branch and none carries this hook's `--detach` head or its owner stamp. So everything this
# hook carries — the #3621 fresh-base fetch, the ADR 0178 600s install budget, the #3943
# owner stamp — is currently inert on that path. The trace below is what makes that
# falsifiable instead of inferred.
#
# The harness's own provisioning is NOT an equivalent substitute for the two inert fixes:
#   * freshness (#3621) — the harness does fetch, but THROTTLED on `FETCH_HEAD` mtime and
#     falling back to the local `HEAD` with only a warning when the fetch fails. This hook
#     fails closed instead, so #3621's guarantee is strictly WEAKER in practice, not equal.
#   * the 600s budget (ADR 0178) — that is a hook-config `timeout`; it governs this hook's
#     invocation and nothing at all about the harness's internal provisioning.
# Neither is visibly broken today, but neither is in effect by our doing.

set -u

# Unconditional invocation trace — the ONE artifact that separates "the harness never invoked
# this hook" from "it invoked it and the hook died early" (#4180). Everything else this script
# writes happens only AFTER `git worktree add` succeeds, so those two cases leave byte-identical
# on-disk evidence and the question is unanswerable from artifacts alone. This line is written
# before any parsing, any PATH manipulation, and any git call: its presence proves invocation,
# its absence proves non-invocation.
#
# PATH-resilient and non-fatal BY CONSTRUCTION, and both properties are load-bearing rather than
# polish: `git worktree add` execs hooks with a stripped PATH (#787–#789) and `.git/hooks` is
# shared across every lane, so a trace that hard-failed here would abort worktree creation for
# every lane in the checkout, not just this one. Hence no jq, no unguarded external command, and
# a failed write degrades to "no trace" and never to a non-zero exit. The log lives outside any
# repo so it can never dirty a worktree (a dirty tree is KEPT forever by the sweep).
KAMPUS_WORKTREE_HOOK_LOG="${KAMPUS_WORKTREE_HOOK_LOG:-/tmp/kampus-worktree-create.log}"
trace() {
	# `date` may be unreachable under a stripped PATH; an unknown timestamp is still proof of
	# invocation, so degrade the field rather than lose the line.
	local ts
	ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || ts=""
	[ -n "$ts" ] || ts="unknown"
	# The whole redirect is wrapped so a FAILED redirect is silenced too: `cmd >>log 2>/dev/null`
	# applies the append first, and the shell reports its failure on the still-open stderr.
	{ printf '%s pid=%s %s\n' "$ts" "$$" "$*" >>"$KAMPUS_WORKTREE_HOOK_LOG"; } 2>/dev/null || true
}
trace "entry"

# Parse the payload FIRST, under the inherited PATH — before the defensive toolchain PATH
# below. Parsing needs only jq-or-coreutils, and keeping it ahead of the toolchain prepend
# is what lets the jq-vs-fallback branch be forced under a controlled PATH (the unit test's
# `env -i`), rather than always resolving jq from a hardcoded standard dir.
payload="$(cat)"

# Extract a scalar field from the JSON payload — jq when available, else a robust
# grep/sed fallback for the flat `"key": "value"` shape WorktreeCreate emits (a hook may
# fire before the toolchain is warm, so it must not hard-depend on jq — like guard.sh).
extract() {
	local key="$1"
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$payload" | jq -r --arg k "$key" '.[$k] // empty'
	else
		printf '%s' "$payload" \
			| grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
			| head -n1 \
			| sed -E "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/"
	fi
}

cwd="$(extract cwd)"
name="$(extract name)"
session_id="$(extract session_id)"

# cwd + name are both mandatory — the path is CONSTRUCTED from them, so either missing
# means there is nothing safe to create. Fail-closed (never a silent no-op).
if [ -z "$cwd" ] || [ -z "$name" ]; then
	trace "fail: payload missing cwd/name"
	echo "create-worktree: WorktreeCreate payload missing cwd/name — cannot provision (fail-closed)." >&2
	exit 1
fi

worktree_path="$cwd/.claude/worktrees/$name"
trace "payload: name=$name session=${session_id:-none} cwd=$cwd"

# NOW ensure a full PATH for git + the post-checkout `pnpm install` it fires. The hook exec
# env's PATH handling is UNDOCUMENTED (the sibling harness `git worktree add` strips PATH to
# /usr/bin — #787/ADR 0109); if that stripping applies here too, `bootstrap-deps` finds no
# pnpm/corepack and clean-SKIPs, leaving the tree dep-less and useless. Prepend the standard
# toolchain locations (Homebrew, /usr/local, system, ~/.local) while PRESERVING the inherited
# PATH (kept last) — OS/standard dirs only, never a per-machine volta/fnm shim (ADR 0109).
export PATH="/opt/homebrew/bin:/usr/local/bin:/bin:/usr/bin:${HOME:-}/.local/bin:${PATH:-}"

# Operate on the repo the payload names, not merely the process cwd, so the constructed path
# and the git op agree even if the hook exec cwd ever drifts from the payload's `cwd`.
if ! cd "$cwd" 2>/dev/null; then
	trace "fail: cwd not accessible"
	echo "create-worktree: payload cwd '$cwd' is not accessible — refusing (fail-closed)." >&2
	exit 1
fi

# Freshen the remote tip BEFORE branching — the #3621 fix. The primary checkout's `origin/main`
# remote-tracking ref only advances on an explicit fetch, and nothing fetches per-spawn; so
# branching off the cached `origin/main` (or the harness default's local `main`) silently bases a
# lane on a STALE tip, missing a sibling lane's just-merged commit. Two serialized same-file lanes
# then both go green in isolation and collide only at ship time (mergeable_state=dirty) — or, worse,
# a clean/green PR silently reverts the sibling's merged work (#3678). The fetch NEVER moves the
# primary's local `main` HEAD (it advances only remote-tracking refs), so the #2143/#2144
# primary-main-corruption class is not reintroduced — a dirty or off-`main` primary is irrelevant
# here because the base is the freshly-fetched remote tip, never local `main`. Fail LOUD if the
# fetch fails rather than silently branching from a possibly-stale base.
if ! git fetch --quiet origin main >&2; then
	trace "fail: git fetch origin main"
	echo "create-worktree: git fetch origin main failed — refusing to branch from a possibly-stale base (fail-closed, #3621)." >&2
	exit 1
fi

# Branch off the just-fetched tip via FETCH_HEAD — guaranteeing freshness independent of whether a
# remote-tracking refspec maps `main`→`origin/main` (FETCH_HEAD is exactly what the fetch above
# just wrote). `--detach` deliberately: a linked worktree can't check out a base that is a LOCAL
# branch already checked out in the primary (`git worktree add <p> main` fatals with 'main is
# already checked out'), and the coder re-branches in its Step-4 preflight regardless, so the base
# HEAD is throwaway. A detached checkout at FETCH_HEAD still fires post-checkout (ADR 0109).
if ! git worktree add --detach "$worktree_path" FETCH_HEAD >&2; then
	trace "fail: git worktree add --detach $worktree_path"
	echo "create-worktree: git worktree add --detach '$worktree_path' FETCH_HEAD failed — refusing (fail-closed)." >&2
	exit 1
fi

# Plant `<worktree>/.claude/.pipeline` -> the live plugin (#4605). A worktree is a SEPARATE working
# tree with its own `.claude/`, so the primary checkout's link does not reach it — every worktree
# needs its own, and it must exist before the occupying agent's first tool call. Planting here, while
# the spawn is still blocked on this hook, is what makes that ordering hold: the harness does not
# adopt the tree until this script exits, so no agent can run in it beforehand.
#
# FAIL-CLOSED, like every other provisioning failure above: a worktree whose link is missing is a
# lane where every skill fence exits 127. That is precisely the state acceptance condition 2 forbids
# a caller from reading as an ordinary negative, so it must never be provisioned silently.
if ! bash "$(dirname -- "${BASH_SOURCE[0]}")/plant-pipeline-link.sh" "$worktree_path" >/dev/null; then
	trace "fail: plant-pipeline-link $worktree_path"
	echo "create-worktree: could not plant '$worktree_path/.claude/.pipeline' — refusing (fail-closed, #4605)." >&2
	exit 1
fi

# Stamp the OWNING SESSION into the new tree's git admin dir, so a reaper can ask "is this tree's
# owner still running?" instead of guessing from age (#3943, ADR 0191). Without a stamp the sweep
# had only mtime, which cannot see a live shipper lane — it removed two mid-run. The stamp lives in
# `.git/worktrees/<name>/`, NOT the working tree: it must never dirty `git status` (a dirty tree is
# KEPT forever) and it must vanish with the worktree, which git's own admin dir gives for free.
# Best-effort by design — a missing stamp reads as owner-unknown, which the sweep KEEPS, so a failure
# here can only ever leak a tree, never destroy a live one. Never fail the spawn over it.
#
# `ownerKind` is LAUNCHER and cannot be otherwise (#4001): this hook runs in the SPAWNING session,
# before the subagent that will occupy the tree exists, so `session_id` is the launcher's — and for
# a long-lived launcher that id stays alive for hours after the occupant finishes. That was measured
# on the v1 crew's long-lived panes, which left with ADR 0279; the property belongs to the stamp,
# not to the crew, so any long-lived launcher reproduces it. Recording WHICH identity this is
# keeps the consumer from reading launcher liveness as occupancy; see
# `packages/pipeline-cli/src/tools/worktree-sweep/owner-liveness.ts` for what each kind licenses.
# Do NOT stamp `occupant` here — there is no occupant yet to name.
if [ -n "$session_id" ]; then
	if gitdir="$(git -C "$worktree_path" rev-parse --absolute-git-dir 2>/dev/null)"; then
		printf '{"sessionId":"%s","ownerKind":"launcher","worktreeName":"%s","stampedAt":"%s"}\n' \
			"$session_id" "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			>"$gitdir/kampus-owner.json" 2>/dev/null \
			&& trace "stamped: $gitdir/kampus-owner.json" \
			|| { trace "fail: stamp write"; echo "create-worktree: could not stamp owner session (tree reads owner-unknown → never reaped)." >&2; }
	else
		trace "fail: stamp gitdir unresolved"
	fi
else
	trace "unstamped: payload carried no session_id"
	echo "create-worktree: payload carried no session_id — tree reads owner-unknown (never reaped, #3943)." >&2
fi

trace "ok: $worktree_path"

# Success: emit ONLY the path on stdout (all git/install chatter went to stderr above).
printf '%s\n' "$worktree_path"
