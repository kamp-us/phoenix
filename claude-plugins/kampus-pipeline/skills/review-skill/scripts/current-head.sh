HEAD_SHA="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"   # the head you reviewed
