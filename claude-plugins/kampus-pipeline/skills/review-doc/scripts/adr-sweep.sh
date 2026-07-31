# Runs on Step 2's DEFAULT ref-only path — no `--worktree`, no materialized tree. `--new` takes
# "a path to the ADR file" (any real file, anywhere), so a `git show` off $PR_REF is all the
# "real file on disk" the sweep needs. $PR_REF is bound by Step 2's `review-head materialize`;
# if that ran in an EARLIER Bash call the variable is gone, so re-source Step 2's `head.env` here
# (`pipeline-cli scratchpad file --slug "review-doc-$PR" --name head.env`) — never re-run the
# materialize just to rebind it, and never carry the path in a variable across the reset.
# CORPUS: `--dir` is deliberately unset, so the sweep reads the repo-root `.decisions/` of the
# checkout you are running in — the BASE (pre-PR) corpus. That is the set you want: it carries
# every live ADR the new one could contradict, and it excludes the new ADR itself, so the subject
# can never rank against its own file. Only the subject is read from the PR head.
# Exit 0 means the mechanical sweep found nothing left to open; non-zero means there is a
# shortlist to clear, or that the sweep was INDETERMINATE and proved nothing.
SUBJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/review-doc-adr-subject.XXXXXX")"   # §SP rule-4 carve-out: allocated AND consumed in this one call
git show "$PR_REF:.decisions/NNNN-slug.md" > "$SUBJECT_DIR/NNNN-slug.md"
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli" adr-sweep shortlist \
  --new "$SUBJECT_DIR/NNNN-slug.md"
SWEEP=$?; rm -rf "$SUBJECT_DIR"   # keep the sweep's status: it, not the cleanup, is the outcome
