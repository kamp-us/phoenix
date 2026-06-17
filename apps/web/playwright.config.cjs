// E2E config for the phoenix SPA + worker.
//
// We do NOT spawn a webServer here — the target is an already-running/remote
// server, never a CI-booted workerd. `baseURL` is read from `E2E_BASE_URL` so
// CI can point the whole suite at the per-PR preview deployment; it falls back
// to the locally-running `pnpm dev` (http://localhost:3000) when the var is
// unset, so local dev is unchanged. Boot time is ~10s and DO state is seeded
// once per dev session — re-spawning per test run would throw away that warmth.
//
// `.cjs` + `module.exports` because ADR 0001 bans `export default` in the
// codebase, and Playwright's CLI requires a default export from the config
// module. CommonJS sidesteps that without bending the rule.

const {defineConfig, devices} = require("@playwright/test");

module.exports = defineConfig({
	testDir: "./tests/e2e",
	timeout: 15_000,
	expect: {timeout: 5_000},
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		actionTimeout: 5_000,
		navigationTimeout: 10_000,
	},
	projects: [
		{
			name: "chromium",
			use: {...devices["Desktop Chrome"]},
		},
	],
});
