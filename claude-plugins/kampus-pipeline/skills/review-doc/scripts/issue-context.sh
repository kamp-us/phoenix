ISSUE=<N>
gh api repos/$REPO/issues/$ISSUE --jq '{number, state, assignee: .assignee.login, body}'
gh api "repos/$REPO/issues/$ISSUE/comments?per_page=100" --jq '.[].body'
