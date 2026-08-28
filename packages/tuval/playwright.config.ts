import {defineConfig} from "@playwright/test";

export default defineConfig({
	testDir: "./test/browser",
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	expect: {timeout: 5_000},
	use: {
		viewport: {width: 1_280, height: 800},
		colorScheme: "dark",
	},
});
