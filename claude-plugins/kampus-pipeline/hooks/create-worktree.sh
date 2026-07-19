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
#  * exit   — 0 on success; NON-ZERO on ANY failure. A non-zero WorktreeCreate blocks
#             creation, so the coder fail-closes on the Step-4 preflight — no worse than
#             today's fall-back-to-primary, and never a silently dep-less worktree.
#
# `git worktree add` fires the existing lefthook post-checkout `bootstrap-deps` install
# (ADR 0109) — we REUSE it, never reimplement it, so 0109's provision-not-share
# correctness is preserved unchanged.

set -u

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

# cwd + name are both mandatory — the path is CONSTRUCTED from them, so either missing
# means there is nothing safe to create. Fail-closed (never a silent no-op).
if [ -z "$cwd" ] || [ -z "$name" ]; then
	echo "create-worktree: WorktreeCreate payload missing cwd/name — cannot provision (fail-closed)." >&2
	exit 1
fi

worktree_path="$cwd/.claude/worktrees/$name"

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
	echo "create-worktree: git worktree add --detach '$worktree_path' FETCH_HEAD failed — refusing (fail-closed)." >&2
	exit 1
fi

# Success: emit ONLY the path on stdout (all git/install chatter went to stderr above).
printf '%s\n' "$worktree_path"
