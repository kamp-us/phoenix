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
// polls the preview until it is provably warm — every first-touched SPA route
// actually renders the mounted topbar (client-side React, so a real browser, not
// a raw fetch) AND the better-auth router answers non-404 on both the read
// (`get-session` GET) and the write (`sign-up/email` POST) paths the setup
// races — then returns. Both auth probes are side-effect-free.
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

// The EXACT write-path the `setup` project's `auth-setup` POSTs to. A warm GET
// on `get-session` proved insufficient: a cold isolate answered the read route
// non-404 while this POST route still fell through to the SPA asset (HTML `404`),
// so the setup 404'd on the very first sign-up (both attempt + retry) even after
// the probe returned "warm" (#716 e2e run 28634179735). Probing the identical
// method+path is the only check that proves what the setup actually races.
// Side-effect-free: an empty body fails better-auth validation (non-404, no user
// created); a `404` HTML fallback still means the write route isn't mounted yet.
const AUTH_WRITE_PROBE_PATH = "/api/auth/sign-up/email";

// The SPA routes the first-touched smoke specs (00-smoke) navigate + assert
// `.kp-topbar` on. Warming only `/` left `/pano/yeni` (a nested route) cold on
// the isolate the parallel worker hit, so its topbar never mounted and the
// smoke spec false-redded. Warm every first-touched route, matching this probe's
// documented intent, not just the root.
const WARM_ROUTES = ["/", "/pano", "/pano/yeni", "/sozluk", "/auth"];

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
				// 1) SPA shell warm — every first-touched route renders the mounted
				//    topbar. The topbar is client-side React, so a raw fetch of the
				//    static shell can't see it; this needs a real browser render. Warm
				//    each route (not just `/`): a cold nested route (`/pano/yeni`) never
				//    mounted its topbar and false-redded the smoke spec.
				for (const route of WARM_ROUTES) {
					await page.goto(route, {waitUntil: "domcontentloaded", timeout: ATTEMPT_TIMEOUT_MS});
					await page.locator(".kp-topbar").waitFor({state: "visible", timeout: ATTEMPT_TIMEOUT_MS});
				}

				// 2) Auth read route warm — a non-404 proves `/api/auth/*` is mounted.
				const readRes = await api.get(AUTH_READY_PATH);
				if (readRes.status() === 404) {
					throw new Error(`${AUTH_READY_PATH} → 404 (auth router not warm yet)`);
				}

				// 3) Auth WRITE route warm — POST the exact `sign-up/email` path+method
				//    the setup races. A read being warm does not imply this write route
				//    is mounted (the #716 cold-start signature); a `404` HTML fallback
				//    here means it isn't yet. Empty body ⇒ validation error (non-404, no
				//    user created), so this stays side-effect-free.
				const writeRes = await api.post(AUTH_WRITE_PROBE_PATH, {data: {}});
				if (writeRes.status() === 404) {
					throw new Error(`${AUTH_WRITE_PROBE_PATH} POST → 404 (auth write route not warm yet)`);
				}

				console.log(
					`[preview-ready] preview warm at ${baseURL} ` +
						`(${WARM_ROUTES.length} routes rendered, auth read+write routes non-404)`,
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
