import {expect, test} from "@playwright/test";

test.describe("LandingPage", () => {
	test.beforeEach(async ({page}) => {
		await page.goto("/");
	});

	test("hero brand, tagline, manifesto, two CTA cards", async ({page}) => {
		await expect(page.locator(".kp-landing__brand")).toContainText("kamp");
		// dot accent inside the brand
		await expect(page.locator(".kp-landing__brand .dot")).toBeVisible();
		await expect(page.locator(".kp-landing__tagline")).toBeVisible();
		await expect(page.locator(".kp-landing__manifesto")).toBeVisible();

		const ctas = page.locator(".kp-landing__cta a");
		await expect(ctas).toHaveCount(2);
		await expect(ctas.nth(0)).toHaveAttribute("href", "/pano");
		await expect(ctas.nth(1)).toHaveAttribute("href", "/sozluk");
	});

	test("CTA cards navigate", async ({page}) => {
		await page.locator(".kp-landing__cta a", {hasText: "pano"}).click();
		await expect(page).toHaveURL("/pano");

		await page.goto("/");
		await page.locator(".kp-landing__cta a", {hasText: "sözlük"}).click();
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
