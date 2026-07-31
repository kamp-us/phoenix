rm -rf "$REVIEW_WT" && git worktree prune && git update-ref -d "$PR_REF"
