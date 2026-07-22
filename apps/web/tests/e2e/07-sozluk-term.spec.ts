import {expect, test} from "@playwright/test";

/**
 * The term page's render contract, reached by a real click-through as an
 * unauthenticated visitor — from BOTH public entry points into a term.
 *
 * The second test is the direct assertion of the sandbox-containment invariant #3724
 * restored: every public term list now masks `term_record` on definitions the viewer can
 * actually read (`landingTerms` via `getLandingTerms`, `recentTerms`/`popularTerms` via
 * `termHasVisibleDefinitionWhere` — #1205/#1424), so the first /sozluk row can no longer
 * be a newcomer's sandbox-only term that renders a dead-end page. /sozluk's list
 * rendering itself stays covered by 06-sozluk-home.
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

	test("from /sozluk → click first row → a term page with at least one definition", async ({
		page,
	}) => {
		await page.goto("/sozluk");
		const firstRow = page.locator("a.kp-sozluk-term-row").first();
		await expect(firstRow).toBeVisible({timeout: 10_000});
		const href = await firstRow.getAttribute("href");
		expect(href).toMatch(/^\/sozluk\/.+/);
		await firstRow.click();
		await expect(page).toHaveURL(href ?? "");

		// The invariant: the first row of the public /sozluk list always leads to a term
		// page carrying at least one definition an anonymous viewer can read.
		await expect(page.locator(".kp-sozluk-definition").first()).toBeVisible();
	});
});
