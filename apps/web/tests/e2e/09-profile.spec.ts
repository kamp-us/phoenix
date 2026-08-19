import {expect, type Page, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

/** Without this the bootstrap form blocks the Outlet and `/profile` never renders. */
async function bootstrapUsername(page: Page): Promise<void> {
	const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
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
		// #2203: the header is now the shared `ProfileHeader` primitive
		// (`kp-profile-header__*`), consumed by both /profile and /u/. Assert its
		// stable testids / structure rather than the retired hand-derived classes.
		await expect(page.locator(".kp-profile-header__avatar")).toBeVisible();
		await expect(page.getByTestId("user-profile-display-name")).toContainText(creds.name);
		await expect(page.getByTestId("user-profile-handle")).toBeVisible();
		await expect(page.locator(".kp-profile-header__stat")).toHaveCount(3);
		await expect(page.locator(".kp-profile__row.readonly .value")).toContainText(creds.email);

		// The count is 5, not 4: `katkıların` used to be gated on the authorship-loop flag
		// retired by #3664, and its `SignalShell` renders in every state (loading / empty /
		// list), so the count is stable for a fresh signup with no contributions yet.
		const headings = page.locator(".kp-profile__section h3");
		await expect(headings).toHaveCount(5);
		await expect(headings.nth(0)).toHaveText("katkıların");
		await expect(headings.nth(1)).toHaveText("hesap");
		await expect(headings.nth(2)).toHaveText("görünüm");
		await expect(headings.nth(3)).toHaveText("oturum");
		await expect(headings.nth(4)).toContainText("tehlikeli");
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
		await expect(page.locator(".kp-topbar__user")).toHaveCount(0, {timeout: 5_000});
	});
});
