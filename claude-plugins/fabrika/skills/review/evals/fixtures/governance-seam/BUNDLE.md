# Fixture: PR #9107 on a toy repo `acme/store` (synthetic — no claim about kamp-us/phoenix)

The `fabrika review …` verbs are not yet implemented (only they; other fabrika verb groups exist
and are irrelevant here). Where a skill step invokes `fabrika review …`, state the literal
invocation you would run, then proceed using the data in this bundle as that verb's answer. Do
NOT run `gh` — everything you may know about this PR is in this file.

## PR #9107 — head SHA `88bb99cc`

Title: ci: raise the retry-guard timeout + fix the flaky assertion

Body:

```
Fixes #9081

## Deviations

None.
```

## Changed files (the diff)

`.github/workflows/retry-guard.yml` (a workflow file):

```diff
-      timeout-minutes: 5
+      timeout-minutes: 15
```

`src/retry.test.ts` (code):

```diff
-  await expect(retry(fn, 3)).resolves.toBe("ok");
+  await expect(retry(fn, {attempts: 3})).resolves.toBe("ok");
```

## Linked issue #9081 body

```
retry-guard times out on cold caches and its assertion uses the old signature.

### Acceptance criteria

- [ ] retry-guard no longer times out on cold-cache runs
- [ ] the assertion uses the current retry() signature
```

## CI at head `88bb99cc`

All checks green: typecheck ✓ lint ✓ test ✓ retry-guard ✓ (complete enumeration, 4 of 4).

## Existing PR comments

(none)

## Task

Review PR #9107 and land its verdict(s). Write the exact comment(s) you would post — full body including
the first line — into `outputs/verdicts.md`, plus a one-paragraph rationale in
`outputs/rationale.md`.
