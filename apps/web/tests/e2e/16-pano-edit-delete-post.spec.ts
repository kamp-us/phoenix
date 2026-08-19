import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";
import {promoteToYazar} from "./_helpers/promote";
import {randomSuffix} from "./_helpers/rand";

/**
 * The post detail does not refetch on a mutation — `editPost` returns the updated
 * scalar fields and Relay's store update rerenders, so no `page.reload()` is needed.
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

		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const originalTitle = `e2e başlık ${suffix}`;
		const originalBody = `original body ${suffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(originalTitle);
		await page.locator('[data-testid="pano-submit-body"]').fill(originalBody);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();

		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
		await expect(page.getByRole("heading", {level: 1})).toContainText(originalTitle, {
			timeout: 10_000,
		});

		const editBtn = page.locator('[data-testid="post-edit"]');
		const deleteBtn = page.locator('[data-testid="post-delete"]');
		await expect(editBtn).toBeVisible();
		await expect(deleteBtn).toBeVisible();

		await editBtn.click();
		const editTitle = page.locator('[data-testid="post-edit-title"]');
		const editBody = page.locator('[data-testid="post-edit-body"]');
		await expect(editTitle).toBeVisible();
		await expect(editTitle).toHaveValue(originalTitle);
		await expect(editBody).toHaveValue(originalBody);

		const editedTitle = `e2e edited ${suffix}`;
		const editedBody = `edited body ${suffix}`;
		await editTitle.fill(editedTitle);
		await editBody.fill(editedBody);
		await page.locator('[data-testid="post-edit-save"]').click();

		await expect(page.getByRole("heading", {level: 1})).toContainText(editedTitle, {
			timeout: 10_000,
		});
		await expect(page.getByText(editedBody)).toBeVisible({timeout: 10_000});
		await expect(page.getByText(originalBody, {exact: true})).toHaveCount(0);

		await page.locator('[data-testid="post-delete"]').click();
		const confirm = page.locator('[data-testid="post-delete-confirm"]');
		await expect(confirm).toBeVisible({timeout: 5_000});
		await confirm.click();

		await page.waitForURL(/\/pano(?:\/?$|\?)/, {timeout: 15_000});

		await expect(page.getByText(editedTitle, {exact: true})).toHaveCount(0, {timeout: 15_000});
	});

	test("non-author does not see edit/delete buttons on someone else's post", async ({page}) => {
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
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
		const postUrl = page.url();
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});

		await signOut(page);
		const bSuffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `bb${bSuffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`b-${bSuffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Go to /pano first so the Layout settles — signUp lands somewhere generic that
		// may auto-redirect — then visit the direct post URL.
		await page.goto("/pano");
		await page.goto(postUrl);
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 15_000});

		await expect(page.locator('[data-testid="post-edit"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="post-delete"]')).toHaveCount(0);

		await expect(page.locator(`[data-testid^="post-vote-"]`).first()).toBeVisible();
	});
});
