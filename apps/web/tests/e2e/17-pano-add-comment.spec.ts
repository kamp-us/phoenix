import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

/**
 * Pano addComment end-to-end.
 *
 * Single author flow:
 *   1. sign up → bootstrap username
 *   2. submit a post → land on /pano/<id>
 *   3. add a top-level comment via the composer → it appears in the tree
 *   4. click "yanıtla" under that comment → inline reply composer appears
 *   5. submit the reply → it appears nested under the parent comment
 *
 * Page reload after submitPost dodges the Suspense double-mount race that
 * surfaced earlier in development.
 */
test.describe("Pano addComment", () => {
	test("submits a top-level comment, then a nested reply", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `cm${suffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`u-${suffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Submit a post.
		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const title = `comment test başlık ${suffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();

		// Land on /pano/<id>.
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		// Post-detail no longer remounts on a mutation —
		// `usePaginationFragment` + connection updaters keep the page tree
		// mounted, so the historical Suspense workaround reload is gone.
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});

		// Wait for the initial thread heading to render so we know the Comments
		// suspense boundary has resolved before we submit (otherwise the first
		// fetchKey refetch can race with the initial fetch and the loading
		// fallback hides the new comment).
		await expect(page.getByRole("heading", {name: /0 yorum/i})).toBeVisible({timeout: 10_000});

		// Add a top-level comment.
		const topLevelBody = `top-level comment ${suffix}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(topLevelBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();

		// New comment appears in the tree. Wait on the comment count heading
		// flipping to "1 yorum" — that's the authoritative signal the comments
		// query refetch landed.
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 15_000});
		await expect(page.getByText(topLevelBody, {exact: false}).first()).toBeVisible({
			timeout: 10_000,
		});

		// Click "yanıtla" on the top-level comment. Pick the first reply trigger
		// — there's only one comment so this is unambiguous.
		const replyTrigger = page.locator('[data-testid^="pano-comment-reply-trigger-"]').first();
		await replyTrigger.click();

		const replyInput = page.locator('[data-testid^="pano-comment-reply-input-"]').first();
		await expect(replyInput).toBeVisible({timeout: 5_000});

		const replyBody = `nested reply ${suffix}`;
		await replyInput.fill(replyBody);
		await page.locator('[data-testid^="pano-comment-reply-submit-"]').first().click();

		// Reply lands and appears in the tree as a second comment row.
		await expect(page.getByText(replyBody, {exact: false})).toBeVisible({timeout: 10_000});
		await expect(page.getByRole("heading", {name: /2 yorum/i})).toBeVisible({timeout: 10_000});
	});
});
