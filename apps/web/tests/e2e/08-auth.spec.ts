import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";

test.describe("AuthPage (/auth)", () => {
	test("renders sign-in card with form", async ({page}) => {
		await page.goto("/auth");
		await expect(page.locator(".kp-auth__card")).toBeVisible();
		await expect(page.getByRole("heading", {name: /giriş yap/i})).toBeVisible();
		await expect(page.getByLabel("e-posta")).toBeVisible();
		await expect(page.getByLabel("parola")).toBeVisible();
		// no görünen ad in sign-in mode
		await expect(page.getByLabel("görünen ad")).toHaveCount(0);
	});

	test("toggle to sign-up reveals name field", async ({page}) => {
		await page.goto("/auth");
		await page.getByRole("button", {name: /^kayıt ol$/i}).click();
		await expect(page.getByRole("heading", {name: /kayıt ol/i})).toBeVisible();
		await expect(page.getByLabel("görünen ad")).toBeVisible();
	});

	test("sign-up redirects to / and topbar shows user pill; sign-out flips back", async ({page}) => {
		const creds = await signUp(page);
		await expect(page).toHaveURL("/");
		const pill = page.locator(".kp-topbar__user");
		await expect(pill).toBeVisible();
		await expect(pill).toContainText(creds.name);

		await signOut(page);
		// pill should be gone, "giriş yap" button should reappear
		await expect(page.locator(".kp-topbar__user")).toHaveCount(0);
		await expect(page.getByRole("button", {name: /giriş yap/i}).first()).toBeVisible();
	});
});
