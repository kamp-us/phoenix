import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";

/**
 * Sözlük editDefinition / deleteDefinition end-to-end (task_6; touched by
 * task_4 of phoenix-relay-idiom).
 *
 * Two flows:
 *   1. Author flow: sign up user A → add a definition → edit it (body
 *      changes) → delete it (card disappears).
 *   2. Cross-user flow: sign up user A → add a definition → sign out →
 *      sign up user B → user B doesn't see edit/delete buttons on user A's
 *      definition.
 *
 * Historical note: this spec previously contained a `page.reload()` between
 * the addDefinition mutation and the edit interactions to escape the
 * Suspense double-mount race triggered by the legacy
 * `setFetchKey`-driven refetch. After task_4 of `phoenix-relay-idiom` the
 * page tree no longer unmounts on a mutation (idiomatic Relay
 * `@deleteRecord` for delete + manual `updater` for prepends + the new
 * `addDefinition` selection set spreads `DefinitionCardFragment` so the
 * row hydrates without a follow-up read), so the reload is gone. The
 * very first `addDefinition` on a fresh slug still triggers an internal
 * page reload from the app to materialize the Term record (a narrow
 * fresh-slug-only path); subsequent edits / deletes don't.
 */
test.describe("Sözlük editDefinition / deleteDefinition (task_6)", () => {
	test("author can edit and delete their own definition", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
		await expect(page.getByText(originalBody)).toBeVisible({timeout: 10_000});

		// Edit affordance is visible to the author.
		const editBtn = page.locator('[data-testid^="definition-edit-"]').first();
		const deleteBtn = page.locator('[data-testid^="definition-delete-"]').first();
		await expect(editBtn).toBeVisible();
		await expect(deleteBtn).toBeVisible();

		// Click edit → an editable textarea appears prefilled with the body.
		await editBtn.click();
		const editTextarea = page.locator('[data-testid^="definition-edit-body-"]').first();
		await expect(editTextarea).toBeVisible();
		await expect(editTextarea).toHaveValue(originalBody);

		// Replace the body and save.
		const editedBody = `edited definition ${suffix}`;
		await editTextarea.fill(editedBody);
		await page.locator('[data-testid^="definition-edit-save-"]').first().click();

		// Edited body is now visible; original is gone.
		await expect(page.getByText(editedBody)).toBeVisible({timeout: 10_000});
		await expect(page.getByText(originalBody, {exact: true})).toHaveCount(0);

		// Wait for the edit textarea to disappear (the editor flipped back to
		// view mode after the mutation completed) so the delete button mounts.
		await expect(page.locator('[data-testid^="definition-edit-body-"]')).toHaveCount(0, {
			timeout: 5_000,
		});

		// Delete → confirm dialog → confirm.
		const deleteBtnAgain = page.locator('[data-testid^="definition-delete-"]').first();
		await expect(deleteBtnAgain).toBeVisible({timeout: 5_000});
		await deleteBtnAgain.click();
		const confirm = page.locator('[data-testid^="definition-delete-confirm-"]').first();
		await expect(confirm).toBeVisible({timeout: 5_000});
		await confirm.click();

		// Card disappears from the page.
		await expect(page.getByText(editedBody)).toHaveCount(0, {timeout: 15_000});
	});

	test("non-author does not see edit/delete buttons on someone else's definition", async ({
		page,
	}) => {
		// User A signs up, bootstraps, writes a definition.
		const aSuffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `aa${aSuffix}@kamp.us`});
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

		// Sign A out, sign B up.
		await signOut(page);
		const bSuffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `bb${bSuffix}@kamp.us`});
		await page.locator("input#bootstrap-username").fill(`b-${bSuffix}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Navigate B to A's term page.
		await page.goto(`/sozluk/${slug}`);
		await expect(page.getByText(aBody)).toBeVisible({timeout: 15_000});

		// User B should NOT see edit / delete affordances on A's definition.
		await expect(page.locator('[data-testid^="definition-edit-"]')).toHaveCount(0);
		await expect(page.locator('[data-testid^="definition-delete-"]')).toHaveCount(0);

		// Sanity: B can still see the vote button (read affordance for non-author).
		await expect(page.locator('[data-testid^="definition-vote-"]').first()).toBeVisible();
	});
});
