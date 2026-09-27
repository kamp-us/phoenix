import {fileURLToPath} from "node:url";
import {configDefaults, defineConfig} from "vitest/config";

// Anchored to the checkout because `**` never enters a dot directory, and lanes run under
// `.claude/worktrees/`.
const repo = fileURLToPath(new URL("../../", import.meta.url));

// Local runs share one machine with sibling lanes and the pre-push hook, so only the local side is
// capped; CI gives a run the whole runner (the same split `apps/tuval/vitest.config.ts` makes, #8119).
const maxWorkers = process.env.CI ? undefined : 2;

export default defineConfig({
	test: {
		// CI runs `vitest --changed <base>` on a PR (#10023), which follows imports only. Here
		// boundary tests scan the source, the pack test builds it, and a test checks
		// `.patterns/tuval-spells.md`, so a change to one of these reruns the whole suite.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			`${repo}packages/tuval/**`,
			`${repo}.patterns/tuval-spells.md`,
		],
		include: ["src/**/*.unit.test.ts", "src/**/*.pack.test.ts", "proof/**/*.unit.test.ts"],
		pool: "forks",
		maxWorkers,
	},
});
