/**
 * The per-suite timeout every test in this package that spawns a REAL subprocess runs under.
 *
 * The rationale, the profiling and the tier rule live once in
 * [`.patterns/subprocess-test-budget.md`](../../../.patterns/subprocess-test-budget.md) (#4014);
 * this is the same ceiling, declared here because workspace members have no source-level
 * dependency edge to import it across.
 *
 * This collapses five per-file copies that had drifted to three different numbers (20s / 30s / 60s).
 * A timeout is an upper bound, not a delay, so landing on the highest of them cannot introduce a
 * false red; what actually made `excess-operand.cli.test.ts` fast is #4857 taking the network out of
 * it and cutting twelve spawns to five, and that is untouched here.
 *
 * The #4858 guard that failed closed on a spawning suite not carrying this value lived in v1 and
 * died with it (#6100), so the value is currently held by this declaration alone.
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
