import {expect, type Page, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Helper: complete the bootstrap form so the signed-in user is past the
 * intercept and `/profile` actually renders. Without this the bootstrap form
 * blocks the Outlet (T13 behaviour).
 */
async function bootstrapUsername(page: Page): Promise<void> {
	const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	await page.locator("input#bootstrap-username").fill(handle);
	await page.getByRole("button", {name: /devam et/i}).click();
	await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
		timeout: 10_000,
	});
}

test.describe("ProfilePage (/profile)", () => {
	test("unauthed → redirects to /auth", async ({page}) => {
		await page.goto("/profile");
		await expect(page).toHaveURL(/\/auth$/, {timeout: 5_000});
	});

	test("signed-in renders avatar + name + email + 3 stats + sections", async ({page}) => {
		const creds = await signUp(page);
		await bootstrapUsername(page);
		await page.goto("/profile");
		await expect(page.locator(".kp-profile__avatar")).toBeVisible();
		await expect(page.locator(".kp-profile__name")).toContainText(creds.name);
		await expect(page.locator(".kp-profile__handle")).toBeVisible();
		await expect(page.locator(".kp-profile__stat")).toHaveCount(3);
		// email row should show the credential email
		await expect(page.locator(".kp-profile__row.readonly .value")).toContainText(creds.email);

		// Section headings: hesap / görünüm / oturum / tehlikeli alan
		const headings = page.locator(".kp-profile__section h3");
		await expect(headings).toHaveCount(4);
		await expect(headings.nth(0)).toHaveText("hesap");
		await expect(headings.nth(1)).toHaveText("görünüm");
		await expect(headings.nth(2)).toHaveText("oturum");
		await expect(headings.nth(3)).toContainText("tehlikeli");
	});

	// #75 interim: the change-email flow needs email-verification infra the worker
	// doesn't have yet (#875), so the e-posta "değiştir" button ships disabled with a
	// hint instead of inert. Assert no silent inert button remains.
	test("e-posta değiştir button is disabled with a hint (no silent inert button)", async ({
		page,
	}) => {
		await signUp(page);
		await bootstrapUsername(page);
		await page.goto("/profile");
		await expect(page.getByTestId("email-change-btn")).toBeDisabled();
		await expect(page.getByTestId("email-change-hint")).toBeVisible();
	});

	test("çıkış yap signs out and topbar reflects", async ({page}) => {
		await signUp(page);
		await bootstrapUsername(page);
		await page.goto("/profile");
		await page.getByRole("button", {name: /^çıkış yap$/i}).click();
		// Wait for the topbar to drop the pill (re-renders on session change).
		await expect(page.locator(".kp-topbar__user")).toHaveCount(0, {timeout: 5_000});
	});
});
