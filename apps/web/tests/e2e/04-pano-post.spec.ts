import {expect, test, type Page} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Walk from /pano to a real post detail page via the comments link
 * (the title link points at the external URL for link posts, so it
 * isn't a reliable in-app navigation).
 */
async function gotoFirstPostDetail(page: Page): Promise<void> {
	await page.goto("/pano");
	const firstPost = page.locator(".kp-pano-post").first();
	await expect(firstPost).toBeVisible({timeout: 10_000});
	const commentsLink = firstPost.locator("a[href^='/pano/']", {hasText: /yorum$/}).first();
	await commentsLink.click();
	await expect(page).toHaveURL(/\/pano\/[^/]+/, {timeout: 10_000});
	await expect(page.locator(".kp-pano-postpage__title")).toBeVisible({timeout: 10_000});
}

test.describe("PanoPostDetail", () => {
	test("renders title, vote control, meta, composer, comment thread", async ({page}) => {
		await gotoFirstPostDetail(page);
		await expect(page.locator(".kp-pano-postpage__title")).toBeVisible();
		// PostVoteWidget renders the .kp-pano-post__vote control
		await expect(page.locator(".kp-pano-post__vote").first()).toBeVisible();
		await expect(page.locator(".kp-pano-postpage__meta .author")).toBeVisible();
		await expect(page.locator(".kp-pano-comment-composer")).toBeVisible();
		// "N yorum" thread heading
		await expect(page.locator(".kp-pano-postpage__thread-heading")).toBeVisible();
	});

	test("back link returns to /pano", async ({page}) => {
		await gotoFirstPostDetail(page);
		await page.locator(".kp-pano-postpage__back").click();
		await expect(page).toHaveURL("/pano");
	});

	test("comment vote toggles aria-pressed (signed in)", async ({page}) => {
		await signUp(page);
		await gotoFirstPostDetail(page);
		const firstUpvote = page.locator(".kp-comment__upvote").first();
		// Some seed posts have no comments; skip in that case rather than fail.
		if (!(await firstUpvote.isVisible().catch(() => false))) {
			test.skip(true, "no comments on the first seeded post");
		}
		const before = await firstUpvote.getAttribute("aria-pressed");
		await firstUpvote.click();
		await expect(firstUpvote).toHaveAttribute(
			"aria-pressed",
			before === "true" ? "false" : "true",
		);
	});
});
