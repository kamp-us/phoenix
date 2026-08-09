# Fixture: issue state (plan surface)

Self-contained world-state; asserts nothing about the real repository.

## Issue #6600 body (claimed already; claim token build:s-22:bbbb2222)

```
Epic ledger requested: split the "profile page v2" feature into buildable children. Known parts:
avatar upload (needs the asset store), bio editing, and a public/private toggle. The asset store
does not exist yet and is being designed by another lane as #6590.

### Acceptance criteria
- [ ] a task ledger with children a builder can pick up cold
- [ ] the dependency on the asset store is explicit
```

## Tree state

```
build tree --require-clean → exit 0, stdout: /work/lanes/build-6600
```
