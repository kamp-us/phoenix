/**
 * Vitest config for worker integration tests.
 *
 * Uses `@cloudflare/vitest-pool-workers` so tests execute inside the actual
 * workerd runtime: real Durable Objects, real D1, real Workflows binding.
 * Tests live under `tests/integration/` and import from the worker module.
 *
 * Kept separate from the project's `vite.config.ts` (which is the SPA build
 * config) — vite-plugin-cloudflare and vitest-pool-workers can't share the
 * same vite config.
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
	plugins: [cloudflareTest(poolOptions)],
	test: {
		include: ["tests/integration/**/*.test.ts"],
		// `cloudflarePool` is the runtime that boots tests inside workerd.
		pool: cloudflarePool(poolOptions),
	},
});
