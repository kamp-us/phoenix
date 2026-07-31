BASE_REF="$(gh api repos/$REPO/pulls/$PR --jq '.base.ref')"   # normally main
git fetch origin "$BASE_REF"                                  # refresh the merge target

# Verify shipped-state against the FETCHED remote ref, not the working tree / local main:
git cat-file -e "origin/$BASE_REF:<path>"          # does this path exist on fresh main?
git show "origin/$BASE_REF:<path>"                 # read its shipped content to confirm
