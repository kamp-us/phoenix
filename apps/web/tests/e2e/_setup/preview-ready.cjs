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
// The budget arithmetic and the failure attribution live in the pure, offline
// unit-tested `preview-ready-policy.cjs`; this file is the thin I/O shell that
// drives a browser and a request context against them (#3179).
//
// `.cjs` + `module.exports` (no `export default`, ADR 0001), mirroring
// `playwright.config.cjs`. Skipped entirely when `E2E_BASE_URL` is unset — the
// local `pnpm dev` target is already warm, there is no cold-start race, and
// local runs stay unchanged.

const {chromium, request} = require("@playwright/test");
const {
	PROBE_KIND,
	PreviewNotWarmError,
	formatAttemptFailure,
	formatWarm,
	probeTimeoutMs,
	sleepAfterAttemptMs,
} = require("./preview-ready-policy.cjs");

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

// The ordered probe list, each one NAMED so a failure identifies itself. The SPA
// routes come first (they warm the isolate the auth probes then hit).
const PROBES = [
	...WARM_ROUTES.map((route) => ({kind: PROBE_KIND.spaRoute, target: route})),
	{kind: PROBE_KIND.authRead, target: AUTH_READY_PATH},
	{kind: PROBE_KIND.authWrite, target: AUTH_WRITE_PROBE_PATH},
];

module.exports = async function waitForPreviewReady() {
	const baseURL = process.env.E2E_BASE_URL;
	if (!baseURL) return; // local dev target is already warm — no cold-start race

	const start = Date.now();
	const deadline = start + READY_BUDGET_MS;
	const browser = await chromium.launch();
	const api = await request.newContext({baseURL});
	let lastError = "(no attempt completed)";
	let lastProbe = null;
	let attempt = 0;
	try {
		const page = await browser.newPage({baseURL});

		// One probe against the live preview. `timeout` is already clamped to the
		// remaining budget by the caller, so no probe can outlive the hard cap.
		const runProbe = async (probe, timeout) => {
			if (probe.kind === PROBE_KIND.spaRoute) {
				// The topbar is client-side React, so a raw fetch of the static shell
				// can't see it — this needs a real browser render. Every first-touched
				// route is warmed, not just `/`: a cold nested route (`/pano/yeni`)
				// never mounted its topbar and false-redded the smoke spec.
				await page.goto(probe.target, {waitUntil: "domcontentloaded", timeout});
				await page.locator(".kp-topbar").waitFor({state: "visible", timeout});
				return;
			}
			// A read being warm does not imply the write route is mounted (the #716
			// cold-start signature): a `404` HTML fallback means it isn't yet. The
			// write probe POSTs the exact path+method the setup races, with an empty
			// body — better-auth rejects it as a validation error (non-404, no user
			// created), so it stays side-effect-free.
			const res =
				probe.kind === PROBE_KIND.authRead
					? await api.get(probe.target, {timeout})
					: await api.post(probe.target, {data: {}, timeout});
			if (res.status() === 404) {
				throw new Error(`${probe.target} → 404 (auth router not warm yet)`);
			}
		};

		while (Date.now() < deadline) {
			attempt += 1;
			const attemptStart = Date.now();
			let probeStart = attemptStart;
			try {
				for (const probe of PROBES) {
					lastProbe = probe;
					probeStart = Date.now();
					// Re-checked BEFORE EVERY probe, not just between attempts: with the
					// old between-attempts-only check an attempt whose probes each ran
					// their full timeout could overrun the "hard cap" by a whole attempt
					// (~100s on top of 90s), so the cap was not one.
					const timeout = probeTimeoutMs({
						remainingMs: deadline - Date.now(),
						attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
					});
					if (timeout === null) throw new Error("readiness budget exhausted mid-attempt");
					await runProbe(probe, timeout);
				}

				console.log(
					formatWarm({
						baseURL,
						attempts: attempt,
						elapsedMs: Date.now() - start,
						probeCount: PROBES.length,
					}),
				);
				return;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				const now = Date.now();
				const sleepMs = sleepAfterAttemptMs({
					attemptElapsedMs: now - attemptStart,
					pollIntervalMs: POLL_INTERVAL_MS,
					remainingMs: deadline - now,
				});
				console.log(
					formatAttemptFailure({
						attempt,
						probe: lastProbe,
						probeElapsedMs: now - probeStart,
						remainingMs: Math.max(0, deadline - now),
						sleepMs,
						lastError,
					}),
				);
				if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
			}
		}
		throw new PreviewNotWarmError({
			baseURL,
			budgetMs: READY_BUDGET_MS,
			elapsedMs: Date.now() - start,
			attempts: attempt,
			probe: lastProbe,
			lastError,
		});
	} finally {
		await api.dispose();
		await browser.close();
	}
};
