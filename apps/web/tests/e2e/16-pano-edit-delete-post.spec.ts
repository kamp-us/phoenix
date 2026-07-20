import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";
import {promoteToYazar} from "./_helpers/promote";
import {randomSuffix} from "./_helpers/rand";

/**
 * Pano editPost / deletePost end-to-end.
 *
 * Two flows:
 *   1. Author flow: sign up user A → submit a post → land on /pano/<id> →
 *      edit it (title/body change) → delete it (navigates back to /pano,
 *      post no longer in feed).
 *   2. Cross-user flow: sign up user A → submit a post → sign out → sign up
 *      user B → user B doesn't see edit/delete affordances on user A's post.
 *
 * After the relay-idiom refactor the post detail no longer
 * refetches the page query on a mutation — `editPost` returns the updated
 * scalar fields and Relay's automatic store update handles the rerender, so
 * the historical `page.reload()` Suspense workaround is gone.
 */
test.describe("Pano editPost / deletePost", () => {
	test("author can edit and delete their own post", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `ep${suffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`u-${suffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Submit a post.
		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const originalTitle = `e2e başlık ${suffix}`;
		const originalBody = `original body ${suffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(originalTitle);
		await page.locator('[data-testid="pano-submit-body"]').fill(originalBody);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();

		// Lands on /pano/<id> with the post title rendered.
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
		await expect(page.getByRole("heading", {level: 1})).toContainText(originalTitle, {
			timeout: 10_000,
		});

		// Edit affordance visible to the author.
		const editBtn = page.locator('[data-testid="post-edit"]');
		const deleteBtn = page.locator('[data-testid="post-delete"]');
		await expect(editBtn).toBeVisible();
		await expect(deleteBtn).toBeVisible();

		// Click edit → title/body inputs appear prefilled.
		await editBtn.click();
		const editTitle = page.locator('[data-testid="post-edit-title"]');
		const editBody = page.locator('[data-testid="post-edit-body"]');
		await expect(editTitle).toBeVisible();
		await expect(editTitle).toHaveValue(originalTitle);
		await expect(editBody).toHaveValue(originalBody);

		// Replace the title/body and save.
		const editedTitle = `e2e edited ${suffix}`;
		const editedBody = `edited body ${suffix}`;
		await editTitle.fill(editedTitle);
		await editBody.fill(editedBody);
		await page.locator('[data-testid="post-edit-save"]').click();

		// Edit returns the updated title/body; Relay merges into the store
		// keyed by id and the page rerenders without a refetch. No reload needed.
		await expect(page.getByRole("heading", {level: 1})).toContainText(editedTitle, {
			timeout: 10_000,
		});
		await expect(page.getByText(editedBody)).toBeVisible({timeout: 10_000});
		await expect(page.getByText(originalBody, {exact: true})).toHaveCount(0);

		// Delete → confirm dialog → confirm → navigate back to /pano.
		await page.locator('[data-testid="post-delete"]').click();
		const confirm = page.locator('[data-testid="post-delete-confirm"]');
		await expect(confirm).toBeVisible({timeout: 5_000});
		await confirm.click();

		// Land back on /pano after the delete.
		await page.waitForURL(/\/pano(?:\/?$|\?)/, {timeout: 15_000});

		// The edited title is no longer in the feed.
		await expect(page.getByText(editedTitle, {exact: true})).toHaveCount(0, {timeout: 15_000});
	});

	test("non-author does not see edit/delete buttons on someone else's post", async ({page}) => {
		// User A signs up, bootstraps, submits a post.
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

		const title = `user A's başlık ${aSuffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${aSuffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();
		// Wait for navigation to the new post id (not /pano/yeni). Post ids
		// start with `post_` (forge prefix).
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
		const postUrl = page.url();
		// Confirm A actually sees their post title before signing out.
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});

		// Sign A out, sign B up.
		await signOut(page);
		const bSuffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `bb${bSuffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`b-${bSuffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Navigate B to A's post page. Go to /pano first so the Layout settles
		// (signUp lands somewhere generic that may auto-redirect), then visit
		// the direct post URL.
		await page.goto("/pano");
		await page.goto(postUrl);
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 15_000});

		// User B should NOT see edit/delete affordances on A's post.
		await expect(page.locator('[data-testid="post-edit"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="post-delete"]')).toHaveCount(0);

		// Sanity: B can still see the vote button (read affordance for non-author).
		await expect(page.locator(`[data-testid^="post-vote-"]`).first()).toBeVisible();
	});
});
