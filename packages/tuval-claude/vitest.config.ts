import {fileURLToPath} from "node:url";
import {configDefaults, defineConfig} from "vitest/config";

// Anchored to the checkout because `**` never enters a dot directory, and lanes run under
// `.claude/worktrees/`.
const repo = fileURLToPath(new URL("../../", import.meta.url));

// The flags and the worker cap are `apps/tuval/vitest.config.ts`'s, for the reasons it gives:
// `--max-old-space-size` turns a runaway passive-update loop into a fast failure (#1470),
// `--no-experimental-webstorage` drops Node 26's `localStorage` global that shadows jsdom's (#7728),
// and only local runs are capped because they share one machine (#8119). Each `*.unit.test.tsx`
// names `jsdom` in its own `@vitest-environment` docblock.
const execArgv = ["--max-old-space-size=512", "--no-experimental-webstorage"];
const maxWorkers = process.env.CI ? undefined : 2;

export default defineConfig({
	test: {
		// CI runs `vitest --changed <base>` on a PR (#10023), which follows imports only. Here
		// boundary tests scan the source, the pack test builds it, and a test reads the catalog, so
		// a change to one of these reruns the whole suite.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			`${repo}packages/tuval-claude/**`,
			`${repo}pnpm-workspace.yaml`,
		],
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.unit.test.ts", "src/**/*.unit.test.tsx"],
					pool: "forks",
					execArgv,
					maxWorkers,
				},
			},
			{
				test: {
					name: "integration",
					include: ["src/**/*.integration.test.ts"],
					pool: "forks",
					execArgv,
					maxWorkers,
					testTimeout: 60_000,
				},
			},
			{
				test: {
					name: "pack",
					include: ["src/**/*.pack.test.ts"],
					pool: "forks",
					maxWorkers,
				},
			},
		],
	},
});
