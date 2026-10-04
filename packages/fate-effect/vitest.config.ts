import {fileURLToPath} from "node:url";
// The suites here build real runtimes over in-memory fixtures — no external
// storage. Real-D1 coverage of the fate server lives in `@kampus/web` (ADR 0082).
import {configDefaults, defineConfig} from "vitest/config";

// Anchored to the checkout because `**` never enters a dot directory, and lanes run under
// `.claude/worktrees/`.
const repo = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
	test: {
		// CI runs `vitest --changed <base>` on a PR (#10023), which follows imports only. Here a
		// test reads its own source files, so a change to one of these reruns the whole suite.
		forceRerunTriggers: [...configDefaults.forceRerunTriggers, `${repo}packages/fate-effect/**`],
		include: ["src/**/*.test.ts"],
	},
});
