// The two test tiers of ADR 0082; see .patterns/alchemy-test-harness.md.
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
					// A file's beforeAll(deploy) provisions a real remote D1 under an isolated
					// stage and migrates it, so the wall clock is provision + migrate + seed +
					// assert. Console intercept is off because alchemy deploys from a child process.
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
