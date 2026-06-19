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
//   - `setup`    — one real Better Auth sign-up against the preview, captured into
//                  the gitignored storageState file (`.auth/user.json`), per run.
//   - `unauth`   — the public read specs; NO storageState (the #567 gate's lane).
//   - `authed`   — the storageState smoke (`25-authed-smoke`); `dependencies:
//                  ['setup']` + the captured storageState, so it starts already
//                  logged in and proves the shared-session path stays wired.
//   - `selfauth` — every remaining spec (the write-flow lane: pano/sözlük
//                  create/vote/edit/delete/comment, profile, live, auth-redirect).
//                  These drive their OWN sign-ups via `_helpers/auth.ts` because
//                  they need specific users — distinct authors, sign-out/re-sign-up
//                  for non-author assertions, two simultaneous clients for live —
//                  which the single shared storageState session can't supply (ADR
//                  0085: "specs that need a specific user/handle still drive their
//                  own sign-up"). So this lane runs with NO injected storageState.
//
// `retries: 1` in CI with trace-on-first-retry is the flake policy the larger
// suite needs (#524); `workers: 1` + `fullyParallel: false` keep the lanes from
// racing on the one shared preview D1 (and the `authed` shared session) (#525).
//
// The `selfauth` lane is a catch-all (`testIgnore`, not an allow-list): any spec
// not explicitly claimed by `unauth`/`authed`/`setup` gates here by default, so a
// NEW spec is gated the moment it lands instead of silently orphaned out of every
// project (the #525 bug — 20 specs that ran in no project, so never gated). To add
// a public read spec, list it in `UNAUTH_SPECS`; everything else gates as a flow.

const path = require("node:path");
const {defineConfig, devices} = require("@playwright/test");

// MUST equal STORAGE_STATE in tests/e2e/_helpers/storage-state.ts (the `.cjs`
// config can't import the `.ts` helper, so the path is mirrored here).
const STORAGE_STATE = path.join(__dirname, "tests", "e2e", ".auth", "user.json");

// The public read specs that run with no session — matched by filename so they
// stay in the no-storageState lane as the suite grows. 24-search is here too: it
// searches preview-seeded terms (public reads), no session needed (ADR 0085).
const UNAUTH_SPECS = [
	"**/00-smoke.spec.ts",
	"**/01-landing.spec.ts",
	"**/03-pano-feed.spec.ts",
	"**/07-sozluk-term.spec.ts",
	"**/24-search.spec.ts",
];

// The storageState smoke — the one spec that consumes the shared `authed` session
// (ADR 0085). Kept separate from the `selfauth` write-flow lane so the two auth
// strategies stay visibly distinct.
const AUTHED_STORAGESTATE_SPECS = ["**/25-authed-smoke.spec.ts"];

// Specs the `setup` project owns (the sign-up that produces storageState) — must
// not also run as a flow.
const SETUP_SPECS = ["**/_setup/**"];

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
			testMatch: AUTHED_STORAGESTATE_SPECS,
			dependencies: ["setup"],
			use: {...devices["Desktop Chrome"], storageState: STORAGE_STATE},
		},
		{
			// The write-flow lane: every spec NOT claimed above. Catch-all by
			// `testIgnore` so a new spec gates by default (see header). NO injected
			// storageState — these drive their own sign-ups (ADR 0085).
			name: "selfauth",
			testIgnore: [...UNAUTH_SPECS, ...AUTHED_STORAGESTATE_SPECS, ...SETUP_SPECS],
			use: {...devices["Desktop Chrome"]},
		},
	],
});
