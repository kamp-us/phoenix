import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

/**
 * Username bootstrap + topbar profile link. A fresh Pasaport user has `username = NULL`, so
 * the Layout mounts <UsernameBootstrap> in place of <Outlet/> until the form is submitted.
 */
test.describe("Username bootstrap", () => {
	test("first sign-in shows the bootstrap form pre-filled with email local-part", async ({
		page,
	}) => {
		const localPart = `bs${Date.now().toString(36)}`;
		const email = `${localPart}@kamp.us`;
		await signUp(page, {email});

		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toBeVisible();
		const input = page.locator("input#bootstrap-username");
		await expect(input).toBeVisible();
		const sanitized = localPart
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/^-+|-+$/g, "");
		await expect(input).toHaveValue(sanitized);
	});

	test("submitting the bootstrap form sets username + profile reachable via user menu", async ({
		page,
	}) => {
		const localPart = `bs${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});

		const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
		const input = page.locator("input#bootstrap-username");
		await input.fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();

		// Bootstrap form gone; the handle is now reachable via the topbar user menu's
		// "Profil" item (#1632 dropped the redundant standalone @username link).
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});
		await page.locator(".kp-topbar__user").first().click();
		await page.getByTestId("topbar-profile-link").click();
		await expect(page).toHaveURL(`/u/${handle}`, {timeout: 5_000});
	});

	test("client-side validation rejects invalid usernames", async ({page}) => {
		const localPart = `bs${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const input = page.locator("input#bootstrap-username");
		await expect(input).toBeVisible();

		// Drop the HTML5 minLength/maxLength so the form can actually submit
		// invalid values and surface the React-side error message.
		await input.evaluate((el) => {
			(el as HTMLInputElement).removeAttribute("minLength");
			(el as HTMLInputElement).removeAttribute("maxLength");
		});

		await input.fill("ab");
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.locator(".kp-auth__error")).toContainText(/en az 3/i);

		await input.fill("Bad Spaces");
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.locator(".kp-auth__error")).toContainText(/küçük harf/i);
	});
});
