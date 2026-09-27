import {fileURLToPath} from "node:url";
import react from "@vitejs/plugin-react";
import {configDefaults, defineConfig} from "vitest/config";

// Anchored to the checkout because `**` never enters a dot directory, and lanes run under
// `.claude/worktrees/`.
const repo = fileURLToPath(new URL("../../", import.meta.url));

// The pack project runs under plain node: `test-setup.ts` patches DOM globals that only jsdom has.
export default defineConfig({
	plugins: [react()],
	test: {
		// CI runs `vitest --changed <base>` on a PR (#10023), which follows imports only. Here
		// contract tests scan the app sources that render this package, and the pack test builds
		// it, so a change to one of these reruns the whole suite.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			`${repo}packages/design/**`,
			`${repo}apps/web/src/**`,
			`${repo}apps/tuval/src/**`,
		],
		projects: [
			{
				extends: true,
				test: {
					name: "design",
					include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
					environment: "jsdom",
					setupFiles: ["./test-setup.ts"],
					exclude: [
						"node_modules/**",
						"dist/**",
						"src/a11y/**/*.test.tsx",
						"src/**/*.pack.test.ts",
					],
				},
			},
			{
				test: {
					name: "pack",
					include: ["src/**/*.pack.test.ts"],
					pool: "forks",
				},
			},
		],
	},
});
