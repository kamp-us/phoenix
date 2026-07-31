gh pr diff $PR \
  || gh api repos/$REPO/pulls/$PR -H "Accept: application/vnd.github.v3.diff"
