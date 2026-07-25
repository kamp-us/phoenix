# The subprocess test tier — one budget, declared at the suite

How a pipeline-cli test that spawns a **real** child process is budgeted, and why the budget is
never the global vitest default.

## The shape

A test that drives the real CLI (`node src/bin.ts <tool> …`), a real hook script, or real `git`
pays a per-spawn cost that has nothing to do with what it asserts. Measured on #4014: a
`node src/bin.ts` child costs ~0.5–0.9s idle, of which ~0.04s is node startup — the rest is the
child resolving and type-stripping the Effect + tool module graph. That cost is CPU-bound, so it
scales with machine load, and phoenix's normal operating condition is many worktree agents at
once. Against vitest's 5s default, a few spawns per test is a **false red on a gate path** — an
agent can't tell "my diff broke something" from "the box was busy."

## The rule

- One shared constant, [`packages/pipeline-cli/src/test-budget.ts`](../packages/pipeline-cli/src/test-budget.ts)
  (`SUBPROCESS_TEST_TIMEOUT_MS`), holds the budget and states the *why* once.
- Declare it **at the suite**, as vitest's third-argument options object — it covers every `it` in
  the file, including ones added later:

  ```ts
  import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";

  describe("worktree-sweep --execute — against a REAL git repo", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
  	it("removes a clean, idle, unlocked orphan", async () => { … }); // no per-test timeout
  });
  ```

- **Never** raise `testTimeout` in `vitest.config.ts`. The 5s default is the right budget for the
  pure unit tests that are the bulk of the package; widening it globally blunts them to buy
  headroom a dozen files need.
- **No per-test literals.** A trailing `}, 30_000)` on an `it` *overrides* the suite budget
  (usually downward) and scatters the number — which is how the tier drifted into three
  unbudgeted files, ten 30s files, and one 60s file before #4014.

A generous ceiling is not a weakened assertion: a timeout is an upper bound, not a delay. 60s
still fails decisively on a genuinely hung child while leaving a >60x margin for load.

## The guard

[`packages/pipeline-cli/src/subprocess-budget.test.ts`](../packages/pipeline-cli/src/subprocess-budget.test.ts)
scans every `src/**/*.test.ts`, treats an **import of `node:child_process`** as tier membership,
and reds if any such file has a `describe` without the budget — fail-closed on zero scope
([ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)). So a new spawning suite joins
the tier by being written, not by being remembered.

## See also

- [effect-testing.md](./effect-testing.md) — the two tiers (`unit` / `integration`) and which to pick
- [golden-real-payload-fixtures.md](./golden-real-payload-fixtures.md) — the other half of hook testing: what payload the real spawn is fed
