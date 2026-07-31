# Isolation preflight FIRST, before the head fetch below. If this review-trivial spawn expected
# worktree isolation (reviewer agent-type) but the #2440 harness no-op dropped it onto the shared
# PRIMARY checkout ($WORKTREE_ROOT unset), fetching the head here is the #2452/#2453
# primary-checkout-detach surface — fail closed LOUD and route up. Single-sourced in
# gh-issue-intake-formats.md §RO-iso (ADR 0172; the write-code wt_preflight sibling). A genuine
# standalone run on the owner's checkout still proceeds (the head read is via `git show`, checkout-free).
iso_preflight review-trivial || exit 1   # ../gh-issue-intake-formats.md §RO-iso — define it there, cite here

HEAD_SHA="$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)"
PR_REF="refs/review-trivial/$PR"
git fetch --no-tags origin "pull/$PR/head:$PR_REF" >/dev/null 2>&1 || git fetch origin "$HEAD_SHA" >/dev/null 2>&1
# read a head file WITHOUT a checkout:  git show "$PR_REF:<path>"   (or "$HEAD_SHA:<path>")
# NEVER `git checkout` / `git switch` to inspect the head — the harness resets this cwd to the
# shared PRIMARY between Bash calls, so a checkout lands there and detaches the human's `main`
# (#2270/#1103); §RO in gh-issue-intake-formats.md forbids switching any working tree outright.

# the PR body carries Fixes #N; pin the linked issue and its acceptance criteria
ISSUE=$(gh api repos/$REPO/pulls/$PR --jq '.body' | grep -ioE '(fix(es|ed)?|close[sd]?|resolve[sd]?)\s+#[0-9]+' | grep -oE '[0-9]+' | head -n1)
gh api repos/$REPO/issues/$ISSUE --jq '.body'   # the ### Acceptance criteria you verify against
