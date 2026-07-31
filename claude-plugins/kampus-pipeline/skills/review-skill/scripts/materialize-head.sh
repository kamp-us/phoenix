# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"
BASE_REF="$(gh api repos/$REPO/pulls/$PR --jq '.base.ref')"   # normally main — your trusted config
git fetch origin "$BASE_REF"

# §HEAD steps 1–3 (resolve the live head SHA via REST, fetch pull/$PR/head into a nonce-uniqued
# per-run ref WITHOUT touching the session tree, assert the fetched ref IS that head, add a
# throwaway DETACHED head worktree) are the shared `pipeline-cli review-head materialize` verb
# (#3690 / #793 / #1807) — cite it, don't re-derive it. `pull/<pr>/head` resolves same-repo AND
# cross-fork; the verb never runs `gh pr checkout` / `git checkout` / `git switch` (which would land
# the head in the shared PRIMARY the harness resets this cwd to and detach the human's `main` —
# #2270/#1103; §RO), and it internally aborts on a fetched-ref ≠ resolved-head mismatch (§HEAD #2)
# so you never review a different SHA than the verdict claims. Persist its emitted head/ref/worktree
# to a per-run mktemp handle so they survive the harness cwd/shell reset between Bash calls (a shell
# var is lost across calls); re-source them with `. "$WT_FILE"` at each later step — NEVER re-derive
# from a shared leaf name (a `git worktree list` re-derivation matches a SIBLING reviewer's tree and
# reads the wrong head's skill text — the #1807 collision). This is the §SP per-run scratchpad
# namespace (gh-issue-intake-formats.md): a PR number is not unique, and a clobbered file reads
# back cleanly with the other run's content (#3718). WT_FILE is a CROSS-CALL carrier — a later
# step re-sources it — so §SP rules 2+3 apply, NOT the rule-4 single-file `mktemp` carve-out
# (that one is for allocate-and-consume inside one call, like VERDICT_FILE below): the path is
# derived deterministically from the session id, so each later step recomputes this same line
# rather than inheriting a lost `$WT_FILE` variable.
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/${CLAUDE_CODE_SESSION_ID:?§SP: session id unset (#3718)}/review-skill-$PR"
mkdir -p "$RUN_SCRATCH" || { echo "review-skill: §SP could not create a per-run scratch dir (#3718)." >&2; exit 1; }
WT_FILE="$RUN_SCRATCH/wt.env"
"$PCLI" review-head materialize --pr "$PR" --worktree \
  | jq -r '"REVIEW_WT=\(.worktreeDir)\nPR_REF=\(.prRef)\nHEAD_SHA=\(.headSha)"' > "$WT_FILE"
. "$WT_FILE"
[ -n "${REVIEW_WT:-}" ] && [ -n "${PR_REF:-}" ] && [ -n "${HEAD_SHA:-}" ] || {
  echo "FATAL: review-head materialize did not yield a head worktree — aborting (never review the base tree; §HEAD)." >&2; exit 1; }

# Enforce the instruction denylist EXPLICITLY (a full checkout lands the head's root CLAUDE.md
# + .claude/.decisions/.patterns): remove them, then ASSERT absent — the load-bearing isolation
# check. The head's skills/** are present as text to READ; the instruction surfaces are not.
git -C "$REVIEW_WT" rm -r -q --cached --ignore-unmatch \
  CLAUDE.md .claude .decisions .patterns
rm -rf "$REVIEW_WT/CLAUDE.md" "$REVIEW_WT/.claude" "$REVIEW_WT/.decisions" "$REVIEW_WT/.patterns"
for p in CLAUDE.md .claude .decisions .patterns; do
  if [ -e "$REVIEW_WT/$p" ]; then
    echo "FATAL: denied instruction surface '$p' present in review worktree — isolation broken; aborting" >&2
    exit 1
  fi
done
