import {expect, test} from "@playwright/test";

test.describe("LandingPage", () => {
	test.beforeEach(async ({page}) => {
		await page.goto("/");
	});

	test("hero brand, tagline, manifesto, rite, join CTA + browse cards", async ({page}) => {
		await expect(page.locator(".kp-landing__brand")).toContainText("kamp");
		// dot accent inside the brand
		await expect(page.locator(".kp-landing__brand .dot")).toBeVisible();
		await expect(page.locator(".kp-landing__tagline")).toBeVisible();
		await expect(page.locator(".kp-landing__manifesto")).toBeVisible();
		await expect(page.locator(".kp-landing__rite")).toBeVisible();

		// join is the figure: the dominant CTA points at /auth
		const join = page.getByTestId("landing-join-cta");
		await expect(join).toBeVisible();
		await expect(join).toHaveAttribute("href", "/auth");

		// browsing is the ground: the two demoted browse cards
		const browse = page.locator(".kp-landing__browse a");
		await expect(browse).toHaveCount(2);
		await expect(browse.nth(0)).toHaveAttribute("href", "/pano");
		await expect(browse.nth(1)).toHaveAttribute("href", "/sozluk");
	});

	test("CTA cards navigate", async ({page}) => {
		await page.getByTestId("landing-join-cta").click();
		await expect(page).toHaveURL("/auth");

		await page.goto("/");
		await page.locator(".kp-landing__browse a", {hasText: "pano"}).click();
		await expect(page).toHaveURL("/pano");

		await page.goto("/");
		await page.locator(".kp-landing__browse a", {hasText: "sözlük"}).click();
		await expect(page).toHaveURL("/sozluk");
	});

	test("stats strip renders 5 stat groups", async ({page}) => {
		const stats = page.locator(".kp-landing__stat");
		await expect(stats).toHaveCount(5);
	});

	test("activity columns render rows", async ({page}) => {
		// LandingPage still uses LANDING_TERMS / POSTS fixtures for both columns;
		// 5 each per slice(0, 5).
		const cols = page.locator(".kp-landing__col");
		await expect(cols).toHaveCount(2);
		const rows = page.locator(".kp-landing-row");
		// 5 from pano col + up to 5 from sozluk col
		expect(await rows.count()).toBeGreaterThan(0);
	});
});
