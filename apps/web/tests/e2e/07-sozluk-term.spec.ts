import {expect, test} from "@playwright/test";

test.describe("SozlukTermPage", () => {
	test("from /sozluk → click first term → /sozluk/<slug>", async ({page}) => {
		await page.goto("/sozluk");
		const firstRow = page.locator(".kp-sozluk-term-row").first();
		await expect(firstRow).toBeVisible({timeout: 10_000});
		const href = await firstRow.getAttribute("href");
		expect(href).toMatch(/^\/sozluk\/.+/);
		await firstRow.click();
		await expect(page).toHaveURL(href ?? "");

		await expect(page.locator(".kp-sozluk-term__crumbs")).toBeVisible();
		await expect(page.locator(".kp-sozluk-term__title")).toBeVisible();
		await expect(page.locator(".kp-sozluk-term__meta")).toContainText("tanım");

		// At least one definition card with vote button + body + footer
		const card = page.locator(".kp-sozluk-definition").first();
		await expect(card).toBeVisible();
		await expect(card.locator(".kp-sozluk-definition__vote-btn")).toBeVisible();
		await expect(card.locator(".kp-sozluk-definition__body")).toBeVisible();
		await expect(card.locator(".kp-sozluk-definition__foot .author")).toBeVisible();

		// Composer at the bottom
		await expect(page.locator(".kp-sozluk-composer")).toBeVisible();

		// Top definition has the --top modifier
		await expect(page.locator(".kp-sozluk-definition--top")).toBeVisible();
	});
});
