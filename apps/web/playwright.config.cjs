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
//
// Projects (ADR 0085 — authenticated e2e via storageState reuse):
//   - `setup`  — one real Better Auth sign-up against the preview, captured into
//                the gitignored storageState file (`.auth/user.json`), per run.
//   - `unauth` — the public read specs; NO storageState (the #567 gate's lane).
//   - `authed` — the shared-session specs; `dependencies: ['setup']` + the
//                captured storageState, so each starts logged in as the SAME
//                "any authed user" (no per-test sign-up). For specs that tolerate
//                a shared, possibly-mutated session (ADR 0085).
//   - `flows`  — the catch-all lane: every spec NOT claimed by `unauth`/`authed`/
//                `setup`. These drive their OWN `signUp` (a pristine user per test)
//                or assert signed-out states, so they take NO storageState and do
//                NOT depend on `setup`. Defined by exclusion (`testIgnore`) rather
//                than an explicit list so a newly-added spec can never silently
//                orphan out of CI — the bug #525 closed (20 write specs matched no
//                project and so ran nowhere). `retries: 1` in CI with
//                trace-on-first-retry is the flake policy the full suite needs;
//                `workers: 1` + `fullyParallel: false` keep the shared `authed`
//                session from racing across specs.

const path = require("node:path");
const {defineConfig, devices} = require("@playwright/test");

// MUST equal STORAGE_STATE in tests/e2e/_helpers/storage-state.ts (the `.cjs`
// config can't import the `.ts` helper, so the path is mirrored here).
const STORAGE_STATE = path.join(__dirname, "tests", "e2e", ".auth", "user.json");

// The public read specs the #567 gate runs — matched by filename so they stay in
// the no-storageState lane as the suite grows. 24-search is here too: it searches
// preview-seeded terms (public reads), no session needed (ADR 0085).
const UNAUTH_SPECS = [
	"**/00-smoke.spec.ts",
	"**/01-landing.spec.ts",
	"**/03-pano-feed.spec.ts",
	"**/07-sozluk-term.spec.ts",
	"**/24-search.spec.ts",
];

// The one spec that reuses the shared storageState session (ADR 0085). Kept as a
// named constant so the `authed` project claims it and the `flows` catch-all
// ignores it — the two lanes can't drift into double-running or dropping it.
const AUTHED_SPECS = /25-authed-smoke\.spec\.ts$/;

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
			name: "setup",
			testMatch: /_setup\/auth\.setup\.ts$/,
			use: {...devices["Desktop Chrome"]},
		},
		{
			name: "unauth",
			testMatch: UNAUTH_SPECS,
			use: {...devices["Desktop Chrome"]},
		},
		{
			name: "authed",
			testMatch: AUTHED_SPECS,
			dependencies: ["setup"],
			use: {...devices["Desktop Chrome"], storageState: STORAGE_STATE},
		},
		{
			name: "flows",
			testIgnore: [...UNAUTH_SPECS, AUTHED_SPECS],
			use: {...devices["Desktop Chrome"]},
		},
	],
});
