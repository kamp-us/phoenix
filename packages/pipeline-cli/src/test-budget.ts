/**
 * The per-suite timeout every pipeline-cli test that spawns a REAL subprocess runs under.
 *
 * Profiled on #4014: a `node src/bin.ts <tool>` child costs ~0.5–0.9s on an idle box, of which
 * ~0.04s is node startup — the rest is the child resolving and type-stripping the Effect + tool
 * module graph. That cost is CPU-bound, so it scales with machine load, and this repo's normal
 * operating condition is many worktree agents at once. Against vitest's 5s default a handful of
 * spawns per test is a false red, not a regression (#2415 hit the same wall on real-git hooks).
 *
 * A timeout is an upper bound, not a delay: 60s still fails decisively on a genuinely hung child
 * while leaving a >60x margin for load. Applied per suite — never by raising the global default,
 * which would blunt the 5s budget the pure unit tests are correctly held to.
 *
 * `subprocess-budget.test.ts` fails closed if a spawning test file does not carry this on every
 * `describe`, so the tier stays complete as new spawning suites land.
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
