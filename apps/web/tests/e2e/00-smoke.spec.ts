import {expect, type Page, test} from "@playwright/test";
import {isCloudflarePlaceholder404} from "../integration/_edge-ready";

/**
 * Smoke pass — for every route the SPA serves, navigate, assert the page
 * renders, the topbar is mounted, and `<html data-theme>` is set. We sample
 * a real sözlük slug + pano id from the live data instead of hardcoding,
 * because the importer ran against the legacy monorepo content and the
 * slugs don't match the dropped fixtures.
 */

const STATIC_ROUTES = ["/", "/pano", "/pano/yeni", "/sozluk", "/auth"] as const;

// Each smoke `test()` gets a fresh Playwright context whose own connection can route to a
// Cloudflare edge PoP the single-context `preview-ready` warm gate never touched — one that hasn't
// yet propagated the SPA fallback for a route and so serves the typed CF edge-placeholder-404 on
// first paint (config runs the suite serially: `workers:1` + `fullyParallel:false`, so this is the
// fresh-per-test-context vs. one-warm-context gap, not a parallel-worker fan-out). `gotoSpaReady`
// polls THROUGH that bounded readiness window (ADR 0127) on the context until the real shell is
// served. Tolerance is scoped to the typed placeholder ONLY: a structured worker JSON 404, or any
// other response, returns at once for the caller's assertion to judge — a genuine failure still reds.
const SPA_READY_DEADLINE_MS = 30_000;
const SPA_READY_POLL_MS = 1_500;

async function gotoSpaReady(page: Page, route: string): Promise<void> {
	const deadline = Date.now() + SPA_READY_DEADLINE_MS;
	// Poll until the served page is not the typed CF placeholder-404, or the budget lapses — then
	// leave the last navigation in place so the caller's assertion reports the truth (a genuinely
	// cold edge past the budget still reds).
	while (Date.now() < deadline) {
		const res = await page.goto(route);
		if (!res || res.status() !== 404) return; // 200 SPA shell, or a non-404 the caller must judge
		if (!isCloudflarePlaceholder404(res.status(), await res.text())) return; // real worker JSON 404
		await page.waitForTimeout(SPA_READY_POLL_MS);
	}
}

for (const route of STATIC_ROUTES) {
	test(`smoke: ${route} renders without console errors`, async ({page}) => {
		// Room past the default 15s per-test cap for the placeholder-404 readiness poll.
		test.setTimeout(SPA_READY_DEADLINE_MS + 15_000);

		// Ride the cold-PoP placeholder window BEFORE wiring console capture, so the transit's
		// `Failed to load resource: 404` noise never poisons the real-error assertion below; then
		// re-navigate with listeners attached to capture the authoritative SPA-shell load.
		await gotoSpaReady(page, route);

		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
		page.on("console", (msg) => {
			if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
		});

		await page.goto(route);
		await expect(page.locator(".kp-topbar")).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("data-theme", /^(dark|light)$/);

		// Ignore noisy expected sign-in warnings from the vote widgets logging
		// when nobody's signed in (those fire from event handlers, not load).
		const realErrors = errors.filter((e) => !/vote requires sign-in/i.test(e));
		expect(realErrors, `Console errors on ${route}: ${realErrors.join("\n")}`).toHaveLength(0);
	});
}

test("smoke: /sozluk/<slug> renders for a real seeded term", async ({page}) => {
	test.setTimeout(SPA_READY_DEADLINE_MS + 15_000);
	await gotoSpaReady(page, "/sozluk");
	const firstTerm = page.locator(".kp-sozluk-term-row").first();
	await expect(firstTerm).toBeVisible({timeout: 10_000});
	const href = await firstTerm.getAttribute("href");
	expect(href).toMatch(/^\/sozluk\/.+/);

	await gotoSpaReady(page, href ?? "/sozluk");
	await expect(page.locator(".kp-topbar")).toBeVisible();
	await expect(page.locator(".kp-sozluk-term__title")).toBeVisible({timeout: 10_000});
});

test("smoke: /pano/<id> renders for a real seeded post", async ({page}) => {
	test.setTimeout(SPA_READY_DEADLINE_MS + 15_000);
	await gotoSpaReady(page, "/pano");
	const firstPost = page.locator(".kp-pano-post").first();
	await expect(firstPost).toBeVisible({timeout: 10_000});
	// The title link uses `post.url ?? post.href` (so external links navigate
	// out). The "N yorum" link is always the in-app pano permalink.
	const commentsLink = firstPost.locator("a[href^='/pano/']", {hasText: /yorum$/}).first();
	await commentsLink.click();
	await expect(page).toHaveURL(/\/pano\/[^/]+/, {timeout: 10_000});
	await expect(page.locator(".kp-pano-postpage__title")).toBeVisible({timeout: 10_000});
});
