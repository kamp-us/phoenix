import {expect, test} from "@playwright/test";

/**
 * Smoke pass — for every route the SPA serves, navigate, assert the page
 * renders, the topbar is mounted, and `<html data-theme>` is set. We sample
 * a real sözlük slug + pano id from the live data instead of hardcoding,
 * because the importer ran against the legacy monorepo content and the
 * slugs don't match the dropped fixtures.
 */

const STATIC_ROUTES = ["/", "/pano", "/pano/yeni", "/sozluk", "/auth"] as const;

for (const route of STATIC_ROUTES) {
	test(`smoke: ${route} renders without console errors`, async ({page}) => {
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
	await page.goto("/sozluk");
	const firstTerm = page.locator(".kp-sozluk-term-row").first();
	await expect(firstTerm).toBeVisible({timeout: 10_000});
	const href = await firstTerm.getAttribute("href");
	expect(href).toMatch(/^\/sozluk\/.+/);

	await page.goto(href ?? "/sozluk");
	await expect(page.locator(".kp-topbar")).toBeVisible();
	await expect(page.locator(".kp-sozluk-term__title")).toBeVisible({timeout: 10_000});
});

test("smoke: /pano/<id> renders for a real seeded post", async ({page}) => {
	await page.goto("/pano");
	const firstPost = page.locator(".kp-pano-post").first();
	await expect(firstPost).toBeVisible({timeout: 10_000});
	// The title link uses `post.url ?? post.href` (so external links navigate
	// out). The "N yorum" link is always the in-app pano permalink.
	const commentsLink = firstPost.locator("a[href^='/pano/']", {hasText: /yorum$/}).first();
	await commentsLink.click();
	await expect(page).toHaveURL(/\/pano\/[^/]+/, {timeout: 10_000});
	await expect(page.locator(".kp-pano-postpage__title")).toBeVisible({timeout: 10_000});
});
