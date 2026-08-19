import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

test.describe("Pano addComment", () => {
	test("submits a top-level comment, then a nested reply", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `cm${suffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`u-${suffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const title = `comment test başlık ${suffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();

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

		const topLevelBody = `top-level comment ${suffix}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(topLevelBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();

		// The count heading flipping is the authoritative signal the comments refetch landed.
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 15_000});
		await expect(page.getByText(topLevelBody, {exact: false}).first()).toBeVisible({
			timeout: 10_000,
		});

		// The owner-scoped in-review signal (#4282). This author signed up in this test and
		// was never promoted, so they are a çaylak by default and their comment really is
		// sandboxed — the flag is derived from live server state, not a fixture. Scoped to
		// the comment's own `<article id="comment-…">` because the çaylak's POST is
		// sandboxed too and renders its own badge in the header.
		const ownComment = page
			.locator('article[id^="comment-"]')
			.filter({hasText: topLevelBody})
			.first();
		await expect(ownComment.getByTestId("incelemede-badge")).toBeVisible({timeout: 10_000});

		// `.first()` is unambiguous here: there is exactly one comment at this point.
		const replyTrigger = page.locator('[data-testid^="pano-comment-reply-trigger-"]').first();
		await replyTrigger.click();

		const replyInput = page.locator('[data-testid^="pano-comment-reply-input-"]').first();
		await expect(replyInput).toBeVisible({timeout: 5_000});

		const replyBody = `nested reply ${suffix}`;
		await replyInput.fill(replyBody);
		await page.locator('[data-testid^="pano-comment-reply-submit-"]').first().click();

		await expect(page.getByText(replyBody, {exact: false})).toBeVisible({timeout: 10_000});
		await expect(page.getByRole("heading", {name: /2 yorum/i})).toBeVisible({timeout: 10_000});
	});
});
