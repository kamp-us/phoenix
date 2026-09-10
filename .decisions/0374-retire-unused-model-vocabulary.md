---
id: 0374
title: Fabrika deletes its unused model vocabulary and tests
status: accepted
date: 2026-09-10
tags: [fabrika, models, retirement, hooks]
---

# 0374 — Fabrika deletes its unused model vocabulary and tests

**What this decides:** Delete Fabrika's unused model table and its tests. Historical lookup moves
to git and decision records.

## Context

The founder selected this deletion during the audit recorded in
[#8885](https://github.com/kamp-us/phoenix/issues/8885). The recorded question asked whether to
delete the unused model table and its tests, with historical lookup kept in git. The answer was
"yup".

ADR [0331](0331-fabrika-spawn-hook-retired.md) deleted the enforcing spawn hook but retained
`packages/fabrika-cli/src/models.ts` as vocabulary. This record amends only that retention clause
and the consequence saying the constants live on. Its hook and fixture decisions still stand.
The existing amendment by ADR [0360](0360-retire-opencode-harness.md) remains in place.

At implementation base `16d3d2d12d686b01670f9bd6e88a1d66f4f4afc0`, repository searches found only
the table's own test importing it. Neither `src/index.ts` nor the source and published export
maps in `packages/fabrika-cli/package.json` expose it. The separate `isAllowlisted` function in
`src/guard/catalog.ts` validates dependencies and does not call this table.

## Decision

**Delete `packages/fabrika-cli/src/models.ts` and `models.unit.test.ts` without replacement.**

The allowlist, aliases, normalization functions and default pin leave current source. ADR
[0116](0116-spawn-guard-durable-default-pin.md) and the graded hook record keep their historical
passages, with dated retirement notes and links pinned to the earlier source.

**Binding constraints.**

- Add no replacement model registry, allowlist, alias map or default-pin module.
- Keep captured hook protocol fixtures and tests protecting nonblocking hook behavior, including
  `pretooluse-polarity.cli.test.ts`.
- Leave hook declarations and runtime behavior unchanged.

## Consequences

The unused executable policy and its self-tests no longer need maintenance. Historical model
lookup requires git, including the
[retired table](https://github.com/kamp-us/phoenix/blob/16d3d2d12d686b01670f9bd6e88a1d66f4f4afc0/packages/fabrika-cli/src/models.ts),
or decision records. No runtime savings or supported behavior change is claimed. Repository
searches cannot rule out outside users importing an unsupported private source path.

## Records

no vocabulary impact
