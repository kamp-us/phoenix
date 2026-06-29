// Preview-readiness gate — runs ONCE before any project/spec (Playwright
// `globalSetup`), so the first-touched smoke specs never race the per-PR
// preview's cold start (issue #1500).
//
// The signature it closes: the per-PR preview worker cold-starts on its first
// request, so the first specs to touch it — `00-smoke` asserting `.kp-topbar`
// on `/` and `/pano`, and the `setup` project's `auth-setup` POST to
// `/api/auth/sign-up/email` — hit a not-yet-warm isolate and saw `.kp-topbar`
// unrendered / a 404, false-redding the BLOCKING e2e gate even though the diff
// was clean (a plain rerun then went green). See ADR 0085 for the lane layout.
//
// This is a BOUNDED readiness probe, NOT a retry of the test assertions: it
// polls the preview until it is provably warm — `/` actually renders the
// mounted topbar (client-side React, so a real browser, not a raw fetch) AND
// the better-auth router answers a side-effect-free GET non-404 — then returns.
// If the preview never warms within the hard cap it THROWS, which fails the
// whole run: a genuinely-broken preview still reds the gate within a sane
// timeout, so this masks no real regression (it never blanket-retries a real
// failure into green — the specs themselves run exactly once, under the
// config's existing `retries`).
//
// `.cjs` + `module.exports` (no `export default`, ADR 0001), mirroring
// `playwright.config.cjs`. Skipped entirely when `E2E_BASE_URL` is unset — the
// local `pnpm dev` target is already warm, there is no cold-start race, and
// local runs stay unchanged.

const {chromium, request} = require("@playwright/test");

// Auth-router readiness probe: a side-effect-free better-auth GET mounted under
// the same `/api/auth/*` route as the `sign-up/email` POST that 404'd on the
// cold isolate (apps/web/worker/features/pasaport/route.ts). 404 ⇒ the auth
// router isn't warm yet; any other status ⇒ the route is mounted and serving.
const AUTH_READY_PATH = "/api/auth/get-session";

const READY_BUDGET_MS = 90_000; // hard cap: a persistent failure reds the gate within this
const ATTEMPT_TIMEOUT_MS = 10_000; // per-attempt page-load / topbar-visible budget
const POLL_INTERVAL_MS = 3_000;

module.exports = async function waitForPreviewReady() {
	const baseURL = process.env.E2E_BASE_URL;
	if (!baseURL) return; // local dev target is already warm — no cold-start race

	const deadline = Date.now() + READY_BUDGET_MS;
	const browser = await chromium.launch();
	const api = await request.newContext({baseURL});
	let lastError = "(no attempt completed)";
	try {
		const page = await browser.newPage({baseURL});
		while (Date.now() < deadline) {
			try {
				// 1) SPA shell warm — `/` renders the mounted topbar. The topbar is
				//    client-side React, so a raw fetch of the static shell can't see it;
				//    this needs a real browser render.
				await page.goto("/", {waitUntil: "domcontentloaded", timeout: ATTEMPT_TIMEOUT_MS});
				await page.locator(".kp-topbar").waitFor({state: "visible", timeout: ATTEMPT_TIMEOUT_MS});

				// 2) Auth router warm — the cold-start signature was `sign-up/email`
				//    → 404; a non-404 here proves the `/api/auth/*` route is mounted.
				const res = await api.get(AUTH_READY_PATH);
				if (res.status() === 404) {
					throw new Error(`${AUTH_READY_PATH} → 404 (auth router not warm yet)`);
				}

				console.log(
					`[preview-ready] preview warm at ${baseURL} (topbar rendered, auth router non-404)`,
				);
				return;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				console.log(
					`[preview-ready] not ready yet: ${lastError} — retrying in ${POLL_INTERVAL_MS}ms…`,
				);
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}
		}
		throw new Error(
			`[preview-ready] preview ${baseURL} not warm within ${READY_BUDGET_MS}ms — last failure: ${lastError}. ` +
				"This is a bounded readiness gate, not a retry of test assertions: a persistent failure reds the e2e gate.",
		);
	} finally {
		await api.dispose();
		await browser.close();
	}
};
