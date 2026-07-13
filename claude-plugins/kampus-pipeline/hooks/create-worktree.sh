#!/usr/bin/env bash
# WorktreeCreate hook: provision an isolation:worktree by running `git worktree add`
# OURSELVES, so the ~13s bootstrap-deps `pnpm install` gets the hook's 600s timeout
# budget instead of racing the harness default-worktree-path's ~13s readiness limit
# (the non-deterministic fall-back-to-primary of #2924/#2923). See ADR 0178.
#
# Contract (Claude Code WorktreeCreate mechanism):
#  * stdin  — a JSON payload carrying `worktree_path` (where to create the tree) and
#             `base_ref` (the ref to check out). Parsed with jq when present, else a
#             dependency-free grep/sed fallback (a hook may fire before the CLI/toolchain
#             is warm, so it must not hard-depend on jq — mirrors guard.sh's fail-soft).
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

worktree_path="$(extract worktree_path)"
base_ref="$(extract base_ref)"

# worktree_path is mandatory — with no destination there is nothing to create.
if [ -z "$worktree_path" ]; then
	echo "create-worktree: no worktree_path in the WorktreeCreate payload — cannot provision." >&2
	exit 1
fi

# base_ref may be absent; fall back to origin/main (the default base every coder branches
# from) so a payload that omits it still yields a usable tree rather than a hard failure.
if [ -z "$base_ref" ]; then
	base_ref="origin/main"
fi

# NOW ensure a full PATH for git + the post-checkout `pnpm install` it fires. The hook exec
# env's PATH handling is UNDOCUMENTED (the sibling harness `git worktree add` strips PATH to
# /usr/bin — #787/ADR 0109); if that stripping applies here too, `bootstrap-deps` finds no
# pnpm/corepack and clean-SKIPs, leaving the tree dep-less and useless. Prepend the standard
# toolchain locations (Homebrew, /usr/local, system, ~/.local) while PRESERVING the inherited
# PATH (kept last) — OS/standard dirs only, never a per-machine volta/fnm shim (ADR 0109).
export PATH="/opt/homebrew/bin:/usr/local/bin:/bin:/usr/bin:${HOME:-}/.local/bin:${PATH:-}"

# `--detach` deliberately: a linked worktree can't check out a base_ref that is a LOCAL
# branch already checked out in the primary (`git worktree add <p> main` fatals with
# 'main is already checked out') — and the coder re-branches off origin/main in its Step-4
# preflight regardless, so the base HEAD is throwaway. A detached checkout at base_ref's
# commit sidesteps the collision and still fires post-checkout (ADR 0109 provisioning).
if ! git worktree add --detach "$worktree_path" "$base_ref" >&2; then
	echo "create-worktree: git worktree add --detach '$worktree_path' '$base_ref' failed — refusing (fail-closed)." >&2
	exit 1
fi

# Success: emit ONLY the path on stdout (all git/install chatter went to stderr above).
printf '%s\n' "$worktree_path"
