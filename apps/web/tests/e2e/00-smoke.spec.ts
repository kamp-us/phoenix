import {expect, test} from "@playwright/test";
import {gotoSpaReady, SPA_READY_DEADLINE_MS} from "./_helpers/spa-ready";

/**
 * Smoke pass — for every static route the SPA serves, navigate, assert the page
 * renders, the topbar is mounted, and `<html data-theme>` is set.
 */

const STATIC_ROUTES = ["/", "/pano", "/pano/yeni", "/sozluk", "/auth"] as const;

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

// A real seeded term and post detail page are reached by click-through in
// `07-sozluk-term.spec.ts` and `04-pano-post.spec.ts`.
