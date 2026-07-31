# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
# §SP FIRST — allocate this run's scratch namespace, and land the head handles in a file inside it.
# $PR_REF / $HEAD_SHA (and $REVIEW_WT below) are needed by LATER Bash calls — Step 4a's ADR sweep
# reads `git show "$PR_REF:…"` — and a shell variable does not survive the harness's between-call
# reset. So they go in `head.env` under the per-run namespace, whose path is a deterministic
# function of this run's session id and is therefore RE-DERIVABLE in any later call. A `mktemp`
# path is not: by the next call the handle itself is a lost shell variable with no way back to it
# (#4041). §SP rules 2+3 apply here, NOT the rule-4 carve-out — that one is for a temp allocated
# AND consumed inside one call, like `VERDICT_FILE` below. `scratchpad` is the allocator (§SP rule
# 2 of ../gh-issue-intake-formats.md); it refuses with a reason on stderr rather than falling back
# to a shared path, and §SP's one-liner is the same namespace for a run with no CLI on PATH.
"$PCLI" scratchpad open --slug "review-doc-$PR" >/dev/null || exit 1   # ONCE, at the start of the run
HEAD_ENV="$("$PCLI" scratchpad file --slug "review-doc-$PR" --name head.env)" || exit 1

# Land the head in a per-run ref via the shared `pipeline-cli review-head materialize` verb
# (#3690 / #793 / #1807) — cite it, don't re-derive it. Ref-only mode (no `--worktree`): it
# resolves the live head SHA (REST), fetches `pull/<pr>/head` into a nonce-uniqued per-run ref
# WITHOUT touching the working tree, and asserts the fetched ref IS that head. It never runs
# `gh pr checkout` / `git checkout` / `git switch` (which would land the head in the shared PRIMARY
# the harness resets this cwd to and detach the human's `main` — #2270/#1103; §RO). It emits the
# head + ref as JSON:
"$PCLI" review-head materialize --pr "$PR" \
  | jq -r '"PR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$HEAD_ENV"
. "$HEAD_ENV"

# Read the head's files off the ref — read-only, no checkout:
git show "$PR_REF:<path>"            # the file's content at the PR head
git grep -n "<pattern>" "$PR_REF"    # search the head tree without checking it out

git update-ref -d "$PR_REF"          # drop the throwaway ref when done
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
"$PCLI" review-head materialize --pr "$PR" --worktree \
  | jq -r '"REVIEW_WT=\(.worktreeDir)\nPR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$HEAD_ENV"
. "$HEAD_ENV"
