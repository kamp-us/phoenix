import {defineConfig} from "vitest/config";

// Local runs share one machine with sibling lanes and the pre-push hook, so only the local side is
// capped; CI gives a run the whole runner (the same split `apps/tuval/vitest.config.ts` makes, #8119).
const maxWorkers = process.env.CI ? undefined : 2;

export default defineConfig({
	test: {
		include: ["src/**/*.unit.test.ts", "src/**/*.pack.test.ts", "proof/**/*.unit.test.ts"],
		pool: "forks",
		maxWorkers,
	},
});
