import {fileURLToPath} from "node:url";
import {configDefaults, defineConfig} from "vitest/config";

// Anchored to the checkout because `**` never enters a dot directory, and lanes run under
// `.claude/worktrees/`.
const repo = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
	test: {
		// CI runs `vitest --changed <base>` on a PR (#10023), which follows imports only. Here a
		// test runs `bin.ts` in a child process, so a change to one of these reruns the whole
		// suite.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			`${repo}packages/app-boundary-guard/**`,
		],
		include: ["src/**/*.test.ts"],
	},
});
