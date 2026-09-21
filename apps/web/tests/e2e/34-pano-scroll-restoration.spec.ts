import {expect, test} from "@playwright/test";

/**
 * Back navigation keeps the reader's place on the pano feed (#9268). It runs after #9266,
 * which is what keeps the feed's loaded window across that back navigation — without it the
 * restored offset would point past a 20-row list and clamp toward the top.
 */
test.describe("pano scroll restoration", () => {
	test("the feed offset survives opening a post and coming back", async ({page}) => {
		await page.goto("/pano");
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});

		// Page once where the preview's feed offers it, so the document is tall enough for the
		// restore to be a real offset rather than a rounding error.
		const loadMore = page.getByRole("button", {name: /^daha fazla$/i}).last();
		if (await loadMore.isVisible().catch(() => false)) {
			await loadMore.click().catch(() => undefined);
			await page.waitForTimeout(1_000);
		}

		await expect.poll(() => page.evaluate(() => window.history.scrollRestoration)).toBe("manual");

		await page.evaluate(() => window.scrollTo({top: 800, left: 0, behavior: "instant"}));
		const offset = await page.evaluate(() => window.scrollY);
		test.skip(offset < 200, "the seeded feed is too short to scroll past the fold");

		// Clicking scrolls the target into view first, which would move the offset under the
		// assertion — so navigate from an in-app post link that is already inside the viewport.
		const titles = page.locator('.kp-pano-post a.kp-pano-post__title[href^="/pano/"]');
		let opened = false;
		for (let i = 0; i < (await titles.count()); i++) {
			const inView = await titles.nth(i).evaluate((node) => {
				const box = node.getBoundingClientRect();
				return box.top >= 0 && box.bottom <= window.innerHeight;
			});
			if (!inView) continue;
			await titles.nth(i).click();
			opened = true;
			break;
		}
		test.skip(!opened, "no in-app post link sits inside the scrolled viewport");

		await expect(page).toHaveURL(/\/pano\/[^/?#]+$/);
		// A forward navigation is an arrival, so the post opens at the top.
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

		await page.goBack();
		await expect(page).toHaveURL(/\/pano(\?.*)?$/);
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
		await expect
			.poll(() => page.evaluate(() => window.scrollY), {timeout: 10_000})
			.toBeGreaterThan(offset - 50);
	});
});
