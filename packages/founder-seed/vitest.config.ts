/**
 * Vitest config — the two test tiers of ADR 0082 (`unit` + `integration`, no
 * middle, no faked engine), `.patterns/alchemy-test-harness.md`.
 *
 *   - `unit` — pure logic, no DB: the `*.unit.test.ts` files (the cohort-read +
 *     tuple-insert statement shapes, the stage-name derivation). They boot no SQL
 *     engine — ADR 0082 bans the `node:sqlite` stand-in.
 *   - `integration` — the seed's drizzle writes run against **real remote Cloudflare
 *     D1** over the production REST transport (`makeD1Rest`, the same path the
 *     `founder-seed` bin ships), provisioned per-file by an alchemy `Test.make`
 *     D1-only stack (`tests/integration/_d1.ts`). The seed/idempotency assertions
 *     live here because they are only-wrong-if-the-DB-differs — does the
 *     `onConflictDoNothing` INSERT actually mint exactly the cohort once and no-op on
 *     a re-run (the class a faked engine could only fake).
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					// `*.unit.test.ts` under the integration dir are pure-logic tests of the
					// harness substrate (e.g. `_stage-name`) — they deploy nothing, so they
					// run in the `unit` tier, not these slow forks.
					exclude: ["tests/integration/**/*.unit.test.ts"],
					// A file's beforeAll(deploy) provisions a real remote D1 under an
					// isolated stage, migrates it, then seeds + asserts over the REST API —
					// so its wall-clock is provision + migrate + seed + assert. Generous
					// timeouts cover that; forks + no console-intercept match apps/web's
					// integration tier (the alchemy deploy logs from a child process).
					testTimeout: 120_000,
					hookTimeout: 180_000,
					pool: "forks",
					fileParallelism: true,
					disableConsoleIntercept: true,
					sequence: {groupOrder: 0},
				},
			},
			{
				test: {
					name: "unit",
					include: ["src/**/*.unit.test.ts", "tests/integration/**/*.unit.test.ts"],
					sequence: {groupOrder: 1},
				},
			},
		],
	},
});
