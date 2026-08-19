import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";
import {promoteToYazar} from "./_helpers/promote";
import {randomSuffix} from "./_helpers/rand";

test.describe("Sözlük editDefinition / deleteDefinition", () => {
	test("author can edit and delete their own definition", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `ed${suffix}@kamp.us`});
		const handle = `u-${suffix}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		const slug = `edit-${suffix}`;
		await page.goto(`/sozluk/${slug}`);

		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});

		const originalBody = `original definition ${suffix}`;
		await composerBody.fill(originalBody);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();

		// First-add on a fresh slug — the app self-reloads once to materialize
		// the Term record. Subsequent edits / deletes stay in-place.
		await expect(page.getByText(originalBody)).toBeVisible({timeout: 15_000});
		// Wait for the *persisted* card (real `def_<ulid>` id) so the edit/delete
		// affordances below bind to the server-backed row, not the optimistic
		// `optimistic:`-id node the fresh-slug reload is about to replace. Mirrors 20.
		await expect(page.locator('[data-testid^="definition-card-def_"]').first()).toBeVisible({
			timeout: 10_000,
		});

		const editBtn = page.locator('[data-testid^="definition-edit-"]').first();
		const deleteBtn = page.locator('[data-testid^="definition-delete-"]').first();
		await expect(editBtn).toBeVisible();
		await expect(deleteBtn).toBeVisible();

		await editBtn.click();
		const editTextarea = page.locator('[data-testid^="definition-edit-body-"]').first();
		await expect(editTextarea).toBeVisible();
		await expect(editTextarea).toHaveValue(originalBody);

		const editedBody = `edited definition ${suffix}`;
		await editTextarea.fill(editedBody);
		await page.locator('[data-testid^="definition-edit-save-"]').first().click();

		await expect(page.getByText(editedBody)).toBeVisible({timeout: 10_000});
		await expect(page.getByText(originalBody, {exact: true})).toHaveCount(0);

		// Wait for the edit textarea to disappear (the editor flipped back to
		// view mode after the mutation completed) so the delete button mounts.
		await expect(page.locator('[data-testid^="definition-edit-body-"]')).toHaveCount(0, {
			timeout: 5_000,
		});

		const deleteBtnAgain = page.locator('[data-testid^="definition-delete-"]').first();
		await expect(deleteBtnAgain).toBeVisible({timeout: 5_000});
		await deleteBtnAgain.click();
		const confirm = page.locator('[data-testid^="definition-delete-confirm-"]').first();
		await expect(confirm).toBeVisible({timeout: 5_000});
		await confirm.click();

		await expect(page.getByText(editedBody)).toHaveCount(0, {timeout: 15_000});
	});

	test("non-author does not see edit/delete buttons on someone else's definition", async ({
		page,
	}) => {
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

		const slug = `cross-${aSuffix}`;
		await page.goto(`/sozluk/${slug}`);
		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});

		const aBody = `user A's definition ${aSuffix}`;
		await composerBody.fill(aBody);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();
		await expect(page.getByText(aBody)).toBeVisible({timeout: 15_000});

		await signOut(page);
		const bSuffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `bb${bSuffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`b-${bSuffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto(`/sozluk/${slug}`);
		await expect(page.getByText(aBody)).toBeVisible({timeout: 15_000});

		await expect(page.locator('[data-testid^="definition-edit-"]')).toHaveCount(0);
		await expect(page.locator('[data-testid^="definition-delete-"]')).toHaveCount(0);

		// The vote button stays: a non-author keeps the read affordances.
		await expect(page.locator('[data-testid^="definition-vote-"]').first()).toBeVisible();
	});
});
