# Register teardown as a trap so a mid-block error still tears the throwaway tree down:
trap 'rm -rf "$REVIEW_WT"; git worktree prune' EXIT
rm -rf "$REVIEW_WT" && git worktree prune   # tear it down on EVERY exit path — PASS or FAIL
