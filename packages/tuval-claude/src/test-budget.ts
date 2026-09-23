/**
 * The per-suite timeout every test in this package that spawns a real subprocess runs under. The
 * rule and its rationale live in
 * [`.patterns/subprocess-test-budget.md`](../../../.patterns/subprocess-test-budget.md); the value is
 * the canonical one in `packages/fabrika-cli/src/test-budget.ts`.
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
