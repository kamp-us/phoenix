# @kampus/structured-output-guard

The **StructuredOutput conformance slice** (issue #742, epic #737). Kills the mined
~55 schema-mismatch subagent tool-errors with no model-behavior change, via three
coordinated pure functions plus thin harness wiring.

## Why

A subagent that must finish with a `StructuredOutput` call used to guess the output
shape, miss the schema, and either hard-fail or eat a terse type error that named only
the first missing field — so the retry converged slowly or not at all. ~55 of last
week's subagent tool-errors were exactly this class.

Three changes, all here:

1. **Schema-in-spawn-prompt** — the exact required/optional field list + a filled
   example is templated into the spawn prompt up front, so the final call conforms
   first-try instead of guessing (`renderSchemaSection`).
2. **2-retry cap** — on a miss the harness lets the subagent self-correct within a
   bounded budget (`DEFAULT_RETRY_CAP = 2`) rather than hard-failing or looping
   unbounded (`decide`).
3. **Richer failure message** — a miss returns the FULL field diff: every missing
   field, every present field, the surfaced extras, and a worked example — so the
   retry has the whole shape and converges in one round (`renderFailureMessage`,
   `validate`).

## Shape

A pure, IO-free core (`src/structured-output-guard.ts`) + a thin Effect CLI
(`src/bin.ts`) — the `leak-guard` / `epic-ledger` idiom (CLAUDE.md: Node over Python,
`effect/unstable/cli`, run with `node src/bin.ts`).

`decide(payload, schema, retryCount, {cap?, example?})` returns one of:

- `accept` — the payload conforms (no required field missing).
- `retry`  — a miss with budget remaining; carries the rich `message` + `retryNumber`.
- `fail`   — a miss with the budget exhausted (`retryCount >= cap`).

`retryCount` is the number of retries **already spent** (0 on the first call), so the
walk is `retry (0) → retry (1) → fail (2)` at the default cap.

## CLI

Both verbs read JSON from stdin.

```bash
# Render the spawn-prompt schema section (inject this into a StructuredOutput subagent's prompt)
echo '{"schema":{"required":["issue","prUrl","notes"]},"example":{"issue":1,"prUrl":"u","notes":"n"}}' \
  | node src/bin.ts prompt

# Run the accept/retry/fail decision on a validation path; exit 0=accept, 1=fail, 2=retry
echo '{"payload":{"issue":1},"schema":{"required":["issue","prUrl","notes"]},"retryCount":0}' \
  | node src/bin.ts decide
```

The `decide` exit-code split (`0` accept / `1` fail / `2` retry) lets a thin shell
wrapper in the orchestrator route without parsing JSON: accept proceeds, retry
re-prompts the agent with `.message`, fail surfaces it and stops. The full `Decision`
(incl. the rich diff + message) is always on stdout.

## Test

```bash
pnpm --filter @kampus/structured-output-guard test
pnpm --filter @kampus/structured-output-guard typecheck
```

The retry core is covered across the three AC cases — **pass** (accept first try),
**retry** (miss, budget remains), **exhaust** (budget gone → fail) — in
`src/structured-output-guard.unit.test.ts`; the CLI exit-code routing in
`src/bin.decide.test.ts`.
