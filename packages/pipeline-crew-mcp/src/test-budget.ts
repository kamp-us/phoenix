/**
 * The per-suite timeout every test in this package that spawns a REAL subprocess runs under.
 *
 * The rationale, the profiling and the tier rule live once in
 * [`.patterns/subprocess-test-budget.md`](../../../.patterns/subprocess-test-budget.md) and in
 * `packages/pipeline-cli/src/test-budget.ts` (#4014); this is the same ceiling, declared here
 * because workspace members have no source-level dependency edge to import it across.
 *
 * `packages/pipeline-cli/src/subprocess-budget.test.ts` fails closed if this file drifts off that
 * canonical value, or if a spawning suite in this package does not carry it (#4858).
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
