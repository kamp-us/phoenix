import {expect, test} from "@playwright/test";

/**
 * The term page's render contract, reached by a real click-through as an
 * unauthenticated visitor.
 *
 * Entry is the LANDING "son eklenenler" column, not /sozluk's: only `landingTerms`
 * masks its ranking on live definitions (`Sozluk.getLandingTerms` — #1205/#1424), so
 * every term it links to is guaranteed to have at least one definition this viewer can
 * read. /sozluk's own `recentTerms` selects `term_record` unmasked, so its first row can
 * be a term whose only definitions are a newcomer's sandboxed ones — a public page that
 * renders empty. That is a live product defect, filed as #3724, NOT something this spec
 * should absorb; /sozluk's list rendering stays covered by 06-sozluk-home.
 */
test.describe("SozlukTermPage", () => {
	test("from / → click first term → /sozluk/<slug>", async ({page}) => {
		await page.goto("/");
		// Both landing columns share `.kp-landing-row__title`; the href prefix is what
		// picks the sözlük one (the posts column renders first).
		const firstRow = page.locator('.kp-landing-row__title[href^="/sozluk/"]').first();
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
