import {expect, type Page, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

const CONFIRMATION = "hesabımı kalıcı olarak sil";

async function bootstrapUsername(page: Page): Promise<void> {
	const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
	await page.locator("input#bootstrap-username").fill(handle);
	await page.getByRole("button", {name: /devam et/i}).click();
	await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
		timeout: 10_000,
	});
}

/**
 * Delete-account flow (#135): the "tehlikeli alan" button opens a typed-confirmation
 * dialog, the confirm button is gated on the exact phrase, and confirming anonymizes
 * the account (ADR 0097) then drops the now-dead session → redirect to /auth.
 */
test.describe("Delete account (/profile tehlikeli alan)", () => {
	test("typed-confirmation gates the delete; confirming signs out and redirects", async ({
		page,
	}) => {
		await signUp(page);
		await bootstrapUsername(page);
		await page.goto("/profile");

		// 1) A single click only opens the dialog — no destructive call yet.
		await page.getByTestId("delete-account-btn").click();
		const confirmBtn = page.getByTestId("delete-account-confirm-btn");
		await expect(confirmBtn).toBeVisible();
		await expect(confirmBtn).toBeDisabled();

		// 2) A wrong phrase keeps the confirm action unreachable.
		const input = page.getByTestId("delete-account-confirm-input");
		await input.fill("yanlış ifade");
		await expect(confirmBtn).toBeDisabled();

		// 3) The exact phrase unlocks it.
		await input.fill(CONFIRMATION);
		await expect(confirmBtn).toBeEnabled();

		// 4) Confirm → account.delete → session torn down → redirect to /auth.
		await confirmBtn.click();
		await expect(page).toHaveURL(/\/auth$/, {timeout: 15_000});

		// 5) The session is genuinely gone: /profile bounces back to /auth.
		await page.goto("/profile");
		await expect(page).toHaveURL(/\/auth$/, {timeout: 10_000});
	});

	test("cancelling performs no deletion and leaves the user signed in", async ({page}) => {
		await signUp(page);
		await bootstrapUsername(page);
		await page.goto("/profile");

		await page.getByTestId("delete-account-btn").click();
		await expect(page.getByTestId("delete-account-confirm-btn")).toBeVisible();
		await page.getByRole("button", {name: /^vazgeç$/i}).click();

		// Still on the profile page, still signed in.
		await expect(page.getByTestId("delete-account-btn")).toBeVisible();
		await page.goto("/profile");
		await expect(page).toHaveURL(/\/profile$/);
	});
});
