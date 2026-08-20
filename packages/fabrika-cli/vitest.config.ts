import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		// A scripted credential, so a unit test exercises the leg under test rather than the token
		// refusal in front of it — and so no run ever picks up the developer's own token.
		env: {GITHUB_TOKEN: "ghp_vitest_scripted"},
	},
});
