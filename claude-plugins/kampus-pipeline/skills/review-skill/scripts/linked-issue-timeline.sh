# --paginate + a STREAMING --jq: per_page caps at 100, so a link event past event 100 is
# invisible without it on a long-lived PR's timeline (#4193)
gh api --paginate "repos/$REPO/issues/$PR/timeline?per_page=100" \
  --jq '.[] | select(.event=="connected" or .event=="cross-referenced") | .source.issue.number // .issue.number' 2>/dev/null
