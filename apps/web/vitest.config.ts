/**
 * Vitest config — two projects: integration (workerd) + unit (node).
 *
 * `integration` boots tests inside the real workerd runtime via
 * `@cloudflare/vitest-pool-workers` — real Durable Objects, real D1, real
 * Workflows binding. Tests under `tests/integration/` exercise the worker
 * module end-to-end.
 *
 * `unit` runs in the default node pool for isolation tests that don't need
 * workerd — Drizzle service contract tests, pure helpers, error encoder
 * round-trips. Unit tests are colocated next to the module under test as
 * `<module>.test.ts` under `worker/**` and `src/**`.
 */
import {cloudflarePool, cloudflareTest} from "@cloudflare/vitest-pool-workers";
import {defineConfig} from "vitest/config";

const poolOptions = {
	main: "./worker/index.ts",
	wrangler: {
		configPath: "./wrangler.jsonc",
	},
};

export default defineConfig({
	test: {
		// 5s default is tight for workerd cold starts on free CI runners.
		testTimeout: 15_000,
		projects: [
			{
				plugins: [cloudflareTest(poolOptions)],
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					pool: cloudflarePool(poolOptions),
					testTimeout: 15_000,
				},
			},
			{
				test: {
					name: "unit",
					include: ["worker/**/*.test.ts", "src/**/*.test.ts"],
					exclude: ["tests/**", "node_modules/**", "dist/**"],
				},
			},
		],
	},
});
