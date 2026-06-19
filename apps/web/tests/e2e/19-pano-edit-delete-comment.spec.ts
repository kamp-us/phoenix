import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";

/**
 * Pano editComment / deleteComment end-to-end.
 *
 * Three flows:
 *   1. Author flow: sign up A → submit a post → add a comment → edit it → body
 *      changes; add a reply to that comment → delete the parent → parent shows
 *      `[silindi]`, reply still visible; delete the leaf reply → reply
 *      disappears from the tree.
 *   2. Cross-user flow: sign up B → user B does NOT see the düzenle/sil
 *      affordances on user A's comments.
 *
 * Every historical `page.reload()` workaround after a mutation has been
 * removed. The post-detail page no longer
 * unmounts on `addComment` / `editComment` / `deleteComment` — manual
 * `updater` + `@deleteRecord` keep the tree mounted, so the Suspense
 * double-mount race the reloads were dodging no longer fires.
 */
test.describe("Pano editComment / deleteComment", () => {
	test("author can edit a comment, delete a parent → [silindi], delete a leaf → removed", async ({
		page,
	}) => {
		const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `cm${suffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`u-${suffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Submit a post.
		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const title = `edit-comment başlık ${suffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();

		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
		const postUrl = page.url();

		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});
		await expect(page.getByRole("heading", {name: /0 yorum/i})).toBeVisible({timeout: 10_000});

		// Add a top-level comment.
		const originalBody = `original comment body ${suffix}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(originalBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 15_000});
		await expect(page.getByText(originalBody, {exact: false}).first()).toBeVisible({
			timeout: 10_000,
		});

		// Resolve the comment id from the vote button data-testid (one comment
		// in the tree → first match is unambiguous).
		const voteBtn = page.locator('[data-testid^="comment-vote-comm_"]').first();
		await expect(voteBtn).toBeVisible({timeout: 10_000});
		const voteTestId = (await voteBtn.getAttribute("data-testid"))!;
		const parentCommentId = voteTestId.replace("comment-vote-", "");

		// Edit it. Open the comment's overflow menu first; the düzenle/sil
		// items only mount when the popup is open.
		await page.locator(`[data-testid="pano-comment-menu-${parentCommentId}"]`).click();
		await page.locator(`[data-testid="pano-comment-edit-trigger-${parentCommentId}"]`).click();
		const editInput = page.locator(`[data-testid="pano-comment-edit-input-${parentCommentId}"]`);
		await expect(editInput).toBeVisible({timeout: 5_000});
		await expect(editInput).toHaveValue(originalBody);
		const editedBody = `EDITED comment body ${suffix}`;
		await editInput.fill(editedBody);
		await page.locator(`[data-testid="pano-comment-edit-save-${parentCommentId}"]`).click();

		await expect(page.getByText(editedBody, {exact: false}).first()).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.getByText(originalBody, {exact: true})).toHaveCount(0, {timeout: 10_000});

		// Reply to the (now edited) parent comment.
		await page.locator(`[data-testid="pano-comment-reply-trigger-${parentCommentId}"]`).click();
		const replyInput = page.locator(`[data-testid="pano-comment-reply-input-${parentCommentId}"]`);
		await expect(replyInput).toBeVisible({timeout: 5_000});
		const replyBody = `nested reply body ${suffix}`;
		await replyInput.fill(replyBody);
		await page.locator(`[data-testid="pano-comment-reply-submit-${parentCommentId}"]`).click();
		await expect(page.getByRole("heading", {name: /2 yorum/i})).toBeVisible({timeout: 15_000});
		await expect(page.getByText(replyBody, {exact: false})).toBeVisible({timeout: 10_000});

		// Resolve the reply id. There are now two vote buttons; the second one
		// is the reply (top-level rendered first by the page's tree builder).
		await expect(page.getByRole("heading", {name: /2 yorum/i})).toBeVisible({timeout: 10_000});
		const allVoteBtns = page.locator('[data-testid^="comment-vote-comm_"]');
		await expect(allVoteBtns).toHaveCount(2, {timeout: 10_000});
		const allTestIds = await allVoteBtns.evaluateAll((els) =>
			els.map((el) => el.getAttribute("data-testid") ?? ""),
		);
		const replyCommentId = allTestIds
			.map((t) => t.replace("comment-vote-", ""))
			.find((id) => id !== parentCommentId)!;
		expect(replyCommentId).toBeTruthy();

		// Delete the parent → soft-delete-with-replies → [silindi] placeholder.
		await page.locator(`[data-testid="pano-comment-menu-${parentCommentId}"]`).click();
		await page.locator(`[data-testid="pano-comment-delete-trigger-${parentCommentId}"]`).click();
		const confirm = page.locator('[data-testid="pano-comment-delete-confirm"]');
		await expect(confirm).toBeVisible({timeout: 5_000});
		await confirm.click();

		// Parent comment now shows [silindi]; reply still visible.
		await expect(page.getByText("[silindi]").first()).toBeVisible({timeout: 10_000});
		await expect(page.getByText(replyBody, {exact: false})).toBeVisible({timeout: 10_000});
		// The original (edited) body is gone.
		await expect(page.getByText(editedBody, {exact: false})).toHaveCount(0, {timeout: 10_000});

		// Delete the leaf reply → fully removed (and the [silindi] parent
		// disappears too once it has no live children).
		await page.locator(`[data-testid="pano-comment-menu-${replyCommentId}"]`).click();
		await page.locator(`[data-testid="pano-comment-delete-trigger-${replyCommentId}"]`).click();
		const confirm2 = page.locator('[data-testid="pano-comment-delete-confirm"]');
		await expect(confirm2).toBeVisible({timeout: 5_000});
		await confirm2.click();

		await expect(page.getByText(replyBody, {exact: false})).toHaveCount(0, {timeout: 10_000});
		// `[silindi]` is gone too — parent had no live children left.
		await expect(page.getByText("[silindi]")).toHaveCount(0);

		// Sanity: post URL still loads.
		expect(page.url()).toBe(postUrl);
	});

	test("non-author does not see edit/delete buttons on someone else's comment", async ({page}) => {
		// User A signs up, posts, adds a comment.
		const aSuffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `aa${aSuffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`a-${aSuffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const title = `cross-user post ${aSuffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${aSuffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
		const postUrl = page.url();

		await expect(page.getByRole("heading", {name: /0 yorum/i})).toBeVisible({timeout: 10_000});

		const aBody = `A's comment body ${aSuffix}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(aBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 15_000});

		// Sanity: A sees their own edit/delete trigger.
		const voteBtn = page.locator('[data-testid^="comment-vote-comm_"]').first();
		await expect(voteBtn).toBeVisible({timeout: 10_000});
		const aCommentId = (await voteBtn.getAttribute("data-testid"))!.replace("comment-vote-", "");
		await expect(page.locator(`[data-testid="pano-comment-menu-${aCommentId}"]`)).toHaveCount(1, {
			timeout: 10_000,
		});

		// Sign A out, sign B up.
		await signOut(page);
		const bSuffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `bb${bSuffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`b-${bSuffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// B navigates to A's post.
		await page.goto("/pano");
		await page.goto(postUrl);
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 15_000});
		await expect(page.getByText(aBody, {exact: false})).toBeVisible({timeout: 15_000});

		// B should NOT see the edit/delete menu on A's comment. The Menu.Root
		// wrapper itself is gated by `comment.isOwner` so the trigger button
		// is absent from the DOM entirely (not just the popup items).
		await expect(page.locator(`[data-testid="pano-comment-menu-${aCommentId}"]`)).toHaveCount(0);

		// Sanity: B can still see the vote button (read affordance).
		await expect(page.locator(`[data-testid="comment-vote-${aCommentId}"]`)).toBeVisible();
	});
});
