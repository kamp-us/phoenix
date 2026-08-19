import {expect, test} from "@playwright/test";

/**
 * The reaction bar's dark-ship invariant (ADR 0083, #1867): with `phoenix-reactions` OFF —
 * its local/CI default — no `reaction-bar-*` element reaches any gated surface.
 *
 * Deliberately off-path only. The flag-on path needs release plumbing and a seeded reaction,
 * so it is covered by `src/components/reaction/reactionModel.test.ts` + `reactionDispatch.test.ts`.
 */
// @journey:phoenix-reactions — the registered reachability journey for the reactions
// vertical (ADR 0173 §2). reachability-guard asserts this tag exists; the e2e job runs it.
test.describe("Reaction bar (dark-ship, phoenix-reactions default off) @journey:phoenix-reactions", () => {
	test("no reaction bar renders on pano post cards while the flag defaults off", async ({page}) => {
		await page.goto("/pano");
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
		await expect(page.locator('[data-testid^="reaction-bar-"]')).toHaveCount(0);
	});

	test("no reaction bar renders on sözlük definition cards while the flag defaults off", async ({
		page,
	}) => {
		await page.goto("/sozluk");
		const firstRow = page.locator(".kp-sozluk-term-row").first();
		await expect(firstRow).toBeVisible({timeout: 10_000});
		await firstRow.click();
		await expect(page.locator(".kp-sozluk-definition").first()).toBeVisible({timeout: 10_000});
		await expect(page.locator('[data-testid^="reaction-bar-"]')).toHaveCount(0);
	});
});
