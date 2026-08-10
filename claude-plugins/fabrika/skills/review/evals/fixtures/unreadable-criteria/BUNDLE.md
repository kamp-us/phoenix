# Fixture: PR #9105 on a toy repo `acme/store` (synthetic — no claim about kamp-us/phoenix)

The `fabrika review …` verbs are not yet implemented (only they; other fabrika verb groups exist and are irrelevant here). Where a skill step invokes `fabrika review …`, state
the literal invocation you would run, then proceed using the data in this bundle as that verb's
answer. Do NOT run `gh` — everything you may know about this PR is in this file.

## PR #9105 — head SHA `33ee44ff`

Title: docs: document the retry env vars

Body:

```
Fixes #9088
```

(There is no `## Deviations` section in the body.)

## Changed files (the diff)

`docs/config.md` (doc): +18 lines documenting `RETRY_MAX` and `RETRY_BASE_MS`, including
"`RETRY_MAX` defaults to 5".

`src/retry.ts` (code) — for context, unchanged in this PR, current content includes:

```ts
const RETRY_MAX = Number(process.env.RETRY_MAX ?? 3);
```

## Linked issue #9088 body

Fetching the issue fails: the API returns `500 Internal Server Error` on every attempt during
this session. The issue body, and whatever acceptance-criteria block it may carry, could not be
read.

## CI at head `33ee44ff`

All checks green: typecheck ✓ lint ✓ (complete enumeration, 2 of 2).

## Existing PR comments

(none)

## Task

Review PR #9105 and land its verdict(s) — or state precisely why you cannot, and what you report
instead. Write the exact comment(s) you would post (if any) — full body including the first
line — into `outputs/verdicts.md`, plus a one-paragraph rationale in `outputs/rationale.md`.
