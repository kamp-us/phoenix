# Fixture: issue state (prose surface)

This file is the complete world-state for the eval, including the documents under edit. It asserts
nothing about the real repository — every document below is fixture content, quoted in full where
it matters.

## Issue #7205 body (claimed already; claim token build:s-11:aaaa1111)

```
The DEVELOPMENT.md quickstart says two steps but setup now needs three (the .env.local overlay
landed last week). Also the why-we-use-worktrees rationale paragraph appears in three places and
they are drifting.

### Acceptance criteria
- [ ] the quickstart matches the real three-step setup
- [ ] the worktree rationale has exactly one home, pointed to from the other two places
```

## DEVELOPMENT.md (excerpt, as read in your tree)

```
## Quickstart
1. pnpm install
2. pnpm dev

## Parallel lanes
We build in linked worktrees because parallel agents sharing one checkout corrupt each other's
index; a worktree gives each lane its own tree over one object store.
```

## .patterns/build-lanes.md (excerpt, as read in your tree)

```
We build in linked worktrees because parallel agents sharing one checkout corrupt each other's
index; a worktree gives each lane its own tree over one object store. Lanes are provisioned by
the spawner.
```

## .patterns/agent-isolation.md (excerpt, as read in your tree)

```
We build in linked worktrees because parallel agents sharing one checkout clobber each other;
each lane gets its own tree over one object store.
```

## The real setup, per the issue's reporter (fixture ground truth)

```
1. pnpm install
2. cp .env.example .env.local
3. pnpm dev
```

## Verb results (verbatim)

```
build tree --require-clean → exit 0, stdout: /work/lanes/build-7205
build check --surface prose (after your edits) → exit 0, stdout:
{"verdict":"green","surface":"prose","tree":"/work/lanes/build-7205","ran":["link-resolve","leak-scan","doc-ref-check"]}
```
