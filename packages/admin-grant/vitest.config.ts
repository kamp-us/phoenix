/**
 * Vitest config — the two test tiers of ADR 0082 (`unit` + `integration`, no
 * middle, no faked engine), `.patterns/alchemy-test-harness.md`.
 *
 *   - `unit` — pure logic, no DB: the `*.unit.test.ts` files (grant statement-building,
 *     the key-encoding contract). They boot no SQL engine — ADR 0082 bans the
 *     `node:sqlite` stand-in.
 *   - `integration` — the grant's drizzle writes run against **real remote Cloudflare
 *     D1** over the production REST transport (`makeD1Rest`, the same path the
 *     `admin-grant` bin ships), provisioned per-file by an alchemy `Test.make` D1-only
 *     stack (`tests/integration/_d1.ts`). The grant/revoke/list assertions live here
 *     because they are only-wrong-if-the-DB-differs — does the INSERT actually land
 *     the tuple and return a changed-count, does the read round-trip it.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					exclude: ["tests/integration/**/*.unit.test.ts"],
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
