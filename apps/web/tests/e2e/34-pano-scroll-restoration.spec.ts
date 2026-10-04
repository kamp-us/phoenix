import {expect, test} from "@playwright/test";

/**
 * Back navigation keeps the reader's place on the pano feed (#9268). It runs after #9266,
 * which is what keeps the feed's loaded window across that back navigation — without it the
 * restored offset would point past a 20-row list and clamp toward the top.
 *
 * Every guard here is an `expect`, never a `test.skip`. The first round of this case carried two
 * runtime skips — one on the seeded feed's height, one on finding a post link inside the scrolled
 * viewport — and one of them fired in CI, so the run reported the case as skipped and asserted
 * nothing at all. A case that can vacate itself is not evidence for the criterion it names.
 */

// A short viewport is what makes the height guard unnecessary rather than conditional: the feed's
// rows overflow 320px on any preview that carries more than a couple of posts, so there is always
// a real offset to lose. The width stays desktop so the layout under test is the ordinary one.
test.use({viewport: {width: 900, height: 320}});

test.describe("pano scroll restoration", () => {
	test("the feed offset survives opening a post and coming back", async ({page}) => {
		await page.goto("/pano");
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});

		await expect.poll(() => page.evaluate(() => window.history.scrollRestoration)).toBe("manual");

		// A post title always routes in-app, on a link post as much as a self post (founder ruling
		// #2437), so this locator is the whole feed rather than a subset the seed might not carry.
		const titles = page.locator('.kp-pano-post a.kp-pano-post__title[href^="/pano/"]');
		await expect(titles.first()).toBeVisible();

		// Scroll the target into view ourselves and read the offset *after*: Playwright scrolls an
		// element into view before clicking it, which would otherwise move the viewport out from
		// under the assertion. Taking the last row is what puts the offset deep in the document.
		const target = titles.last();
		await target.scrollIntoViewIfNeeded();
		const offset = await page.evaluate(() => window.scrollY);
		expect(offset, "the seeded feed must be tall enough to lose a real offset").toBeGreaterThan(
			200,
		);

		await target.click();
		await expect(page).toHaveURL(/\/pano\/[^/?#]+$/);
		// A forward navigation is an arrival, so the post opens at the top.
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

		await page.goBack();
		await expect(page).toHaveURL(/\/pano(\?.*)?$/);
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
		// `offset` is a Node-side binding, so it crosses into the page as an argument — reading it
		// straight out of the callback is a `ReferenceError` in the browser context.
		await expect
			.poll(() => page.evaluate((saved) => Math.abs(window.scrollY - saved), offset), {
				timeout: 10_000,
			})
			.toBeLessThanOrEqual(50);
	});
});
