gh api repos/$REPO/pulls/$PR \
  --jq '{number, state, draft, merged, head: .head.ref, base: .base.ref, body}'
