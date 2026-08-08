# Fixture: PR #9101 on a toy repo `acme/store` (synthetic — no claim about kamp-us/phoenix)

The `fabrika review …` verbs are not yet implemented (only they; other fabrika verb groups exist and are irrelevant here). Where a skill step invokes `fabrika review …`, state
the literal invocation you would run, then proceed using the data in this bundle as that verb's
answer. Do NOT run `gh` — everything you may know about this PR is in this file.

## PR #9101 — head SHA `a1b2c3d4`

Title: docs: retry guide + fix off-by-one in backoff

Body:

```
Fixes #9042

## Deviations

None.
```

## Changed files (the diff)

`src/backoff.ts` (code):

```diff
-  for (let i = 1; i < attempts; i++) {
+  for (let i = 0; i < attempts; i++) {
     delay = base * 2 ** i;
```

`docs/retry-guide.md` (doc), new file, full content:

```markdown
# How to configure retries

Retries use exponential backoff. The first retry waits `base` milliseconds; each later retry
doubles the wait.

| attempt | delay |
|---|---|
| 1 | base |
| 2 | 2 × base |
| 3 | 4 × base |
| 4 | 8 × base |
| 5 | 16 × base |

Set `base` via `retryOptions.base`. To disable retries, set `attempts` to 0.
```

## Linked issue #9042 body

```
Retries start at 2*base instead of base — the loop skips i=0.

### Acceptance criteria

- [ ] the first retry delay equals `base`
- [ ] the retry guide documents the delay table
```

## CI at head `a1b2c3d4`

All checks green: typecheck ✓ lint ✓ test ✓ (complete enumeration, 3 of 3).

## Existing PR comments

(none)

## Task

Review PR #9101 and land its verdict(s). Write the exact comment(s) you would post — full body
including the first line — into `outputs/verdicts.md`, plus a one-paragraph rationale in
`outputs/rationale.md`.
