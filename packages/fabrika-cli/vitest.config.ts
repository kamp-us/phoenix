import {fileURLToPath} from "node:url";
import {configDefaults, defineConfig} from "vitest/config";

// Globs are anchored to the checkout because `**` never enters a dot directory, and lanes run
// under `.claude/worktrees/`.
const repo = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		// A scripted credential, so a unit test exercises the leg under test rather than the token
		// refusal in front of it — and so no run ever picks up the developer's own token.
		env: {GITHUB_TOKEN: "ghp_vitest_scripted"},
		// CI runs `vitest --changed <base>` on a PR (#10023), which follows imports only. These are
		// the files tests read through `fs` instead, so changing one reruns the whole suite.
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			`${repo}claude-plugins/**`,
			`${repo}claude-plugins/*/.*/**`,
			`${repo}.fabrika.jsonc`,
			`${repo}.fabrika.schema.json`,
			`${repo}.claude/settings.json`,
			`${repo}release-please-config.json`,
			`${repo}infra/preview-auth-key/**`,
			`${repo}packages/fabrika-cli/{docs,scripts,test-fixtures}/**`,
			`${repo}packages/fabrika-cli/*.{md,json}`,
			`${repo}packages/fabrika-cli/src/**/!(*.ts)`,
		],
	},
});
