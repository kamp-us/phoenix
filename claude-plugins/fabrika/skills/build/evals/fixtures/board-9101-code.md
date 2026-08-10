# Fixture: issue state (code surface)

This file is the complete world-state for the eval. It asserts nothing about the real repository.

## Raw board listing (what the tracker currently holds — NOT a verb's filtered output; deciding
## what the pool verb would and would not emit from this is part of the task)

| # | title | labels | assignees |
|---|---|---|---|
| 9101 | Editor loses focus after save | type:bug, p1, status:triaged, ready-for:agent | — |
| 9102 | Rework the sözlük landing hero visuals | type:feature, p1, status:triaged, ready-for:agent | — |
| 9103 | Decide: session cookie TTL policy | type:decision, p1, status:triaged, ready-for:human | — |
| 9104 | Fix flaky test in worker/auth | type:bug, p0, status:triaged | — |
| 9105 | Migrate date formatting helper | type:chore, p2, status:triaged, ready-for:agent | opus-agent |

## Issue #9101 body

```
After saving a definition, keyboard focus jumps to the toolbar. Reproduce: edit, save, type — the
text lands in the search box.

### Acceptance criteria
- [ ] focus stays in the editor after save
- [ ] a regression test covers the save → type path
```

## Tree state (verbatim output of the isolation check)

```
build tree --require-clean
→ exit 0, stdout: /work/lanes/build-9101
```

## Validation state after your first implementation pass

```
build check --surface code
→ exit 18, stderr:
   src/features/sozluk/editor.tsx(88,14): error TS2345 …
   build check: red — pnpm typecheck failed; diagnostics above.
```
