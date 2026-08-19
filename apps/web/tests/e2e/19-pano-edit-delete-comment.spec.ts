import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";
import {promoteToYazar} from "./_helpers/promote";
import {randomSuffix} from "./_helpers/rand";

/**
 * No `page.reload()` after a mutation: manual `updater` + `@deleteRecord` keep the
 * comment tree mounted, so the Suspense double-mount race the reloads dodged is gone.
 */
test.describe("Pano editComment / deleteComment", () => {
	test("author can edit a comment, delete a parent → [silindi], delete a leaf → removed", async ({
		page,
	}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `cm${suffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`u-${suffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

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

		await page.locator(`[data-testid="pano-comment-reply-trigger-${parentCommentId}"]`).click();
		const replyInput = page.locator(`[data-testid="pano-comment-reply-input-${parentCommentId}"]`);
		await expect(replyInput).toBeVisible({timeout: 5_000});
		const replyBody = `nested reply body ${suffix}`;
		await replyInput.fill(replyBody);
		await page.locator(`[data-testid="pano-comment-reply-submit-${parentCommentId}"]`).click();
		await expect(page.getByRole("heading", {name: /2 yorum/i})).toBeVisible({timeout: 15_000});
		await expect(page.getByText(replyBody, {exact: false})).toBeVisible({timeout: 10_000});

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

		await page.locator(`[data-testid="pano-comment-menu-${parentCommentId}"]`).click();
		await page.locator(`[data-testid="pano-comment-delete-trigger-${parentCommentId}"]`).click();
		const confirm = page.locator('[data-testid="pano-comment-delete-confirm"]');
		await expect(confirm).toBeVisible({timeout: 5_000});
		await confirm.click();

		await expect(page.getByText("[silindi]").first()).toBeVisible({timeout: 10_000});
		await expect(page.getByText(replyBody, {exact: false})).toBeVisible({timeout: 10_000});
		await expect(page.getByText(editedBody, {exact: false})).toHaveCount(0, {timeout: 10_000});

		// Delete the leaf reply → fully removed (and the [silindi] parent
		// disappears too once it has no live children).
		await page.locator(`[data-testid="pano-comment-menu-${replyCommentId}"]`).click();
		await page.locator(`[data-testid="pano-comment-delete-trigger-${replyCommentId}"]`).click();
		const confirm2 = page.locator('[data-testid="pano-comment-delete-confirm"]');
		await expect(confirm2).toBeVisible({timeout: 5_000});
		await confirm2.click();

		await expect(page.getByText(replyBody, {exact: false})).toHaveCount(0, {timeout: 10_000});
		await expect(page.getByText("[silindi]")).toHaveCount(0);

		expect(page.url()).toBe(postUrl);
	});

	test("non-author does not see edit/delete buttons on someone else's comment", async ({page}) => {
		const aSuffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		const emailA = `aa${aSuffix}@kamp.us`;
		await signUp(page, {email: emailA});
		// A's content must be readable by B below, and a çaylak's content lands sandboxed
		// (read-masked from everyone but its author and a mod) — so A authors as a yazar.
		await promoteToYazar(emailA);
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

		const voteBtn = page.locator('[data-testid^="comment-vote-comm_"]').first();
		await expect(voteBtn).toBeVisible({timeout: 10_000});
		const aCommentId = (await voteBtn.getAttribute("data-testid"))!.replace("comment-vote-", "");
		await expect(page.locator(`[data-testid="pano-comment-menu-${aCommentId}"]`)).toHaveCount(1, {
			timeout: 10_000,
		});

		await signOut(page);
		const bSuffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `bb${bSuffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`b-${bSuffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano");
		await page.goto(postUrl);
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 15_000});
		await expect(page.getByText(aBody, {exact: false})).toBeVisible({timeout: 15_000});

		// The Menu.Root wrapper is gated by `comment.isOwner`, so for a non-owner the
		// trigger button is absent from the DOM entirely — not just the popup items.
		await expect(page.locator(`[data-testid="pano-comment-menu-${aCommentId}"]`)).toHaveCount(0);

		await expect(page.locator(`[data-testid="comment-vote-${aCommentId}"]`)).toBeVisible();
	});
});
