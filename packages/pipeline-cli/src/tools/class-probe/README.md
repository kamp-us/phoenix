# class-probe

`pipeline-cli class-probe classify` — the deterministic artifact-class probe the
**reviewer fan** and **ship-it Step 0** both run, so they cannot disagree on a diff's
required class coverage (issue
[#2434](https://github.com/kamp-us/phoenix/issues/2434)).

## Why it exists

The reviewer's multi-class fan (#2386) and ship-it Step 0 both re-resolve the same
`HAS_*_RE` probes from `gh-issue-intake-formats.md` §CLASS, so on paper their class sets
agree. But on **PR #2430** the reviewer read `.glossary/TERMS.md` as a doc surface and
fanned only `review-skill`, leaving the `review-code` namespace empty; ship-it Step 0
correctly classified `.glossary/**` as **has-code**, required a `review-code` PASS, and
its fail-closed conjunction refused to enqueue — a wasted coordinator round-trip the fan
was built to eliminate.

An LLM eyeball is not a probe. `.glossary/**` is a non-obvious has-code member (it reads
like vocabulary/docs, but the glossary is owned by `review-code` Step 3c, not
`review-doc`; #919). This tool makes the classification **executable and unit-tested** —
`.glossary/** → has-code` is pinned, not inferred — so both gates run the same command
and `dispatched-gate == required-gate` holds by construction.

## Single source, no third copy

The four `HAS_CODE_RE` / `HAS_SKILLS_RE` / `HAS_DOCS_EXCLUDE_RE` / `HAS_DOCS_RE` regexes
are **parsed from** `gh-issue-intake-formats.md` §CLASS at run time — the one definition
ship-it and the reviewer already re-resolve — never re-declared here. An unreadable or
truncated §CLASS falls back to the same fail-closed defaults the gates' `reresolve_re`
uses (`.` for the match probes, `$^` for the docs carve-out): every class fires, so the
worst case is an extra gate run, never a silently-missing namespace.

The core (`class-probe.ts`) mirrors the §CLASS bash exactly: has-code / has-skills are
direct regex matches; has-docs is carve-then-test (`grep -Ev exclude | grep -Eq docs`).

## Usage

```bash
# The reviewer fan / ship-it Step 0 probe — feed it the PR's changed files:
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
  | pipeline-cli class-probe classify              # prints one present has-* class per line
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
  | pipeline-cli class-probe classify --namespaces # prints the review-* namespaces to dispatch/require

git diff --name-only origin/main... | pipeline-cli class-probe classify
pipeline-cli class-probe classify --files-from changed.txt
pipeline-cli class-probe classify --root <dir>     # read §CLASS under a specific root (default: walk up)
```

Present classes go to **stdout** (one per line); a human summary goes to **stderr**. Exit
is always 0 — this classifies, it does not gate. `review-design` (the UI-affecting class)
is resolved separately from ship-it's `UI_RE` (`ui_reresolve`) and is out of this tool's
scope.
