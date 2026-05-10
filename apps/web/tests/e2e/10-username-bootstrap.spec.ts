import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Username bootstrap + topbar profile link (task_13).
 *
 * After signing up, a fresh Pasaport user has `username = NULL`. The Layout
 * intercepts the route and mounts <UsernameBootstrap> in place of <Outlet/>.
 * Once the user submits the form, the topbar swaps the @username link in and
 * routes /u/<username> to the profile page.
 */
test.describe("Username bootstrap (task_13)", () => {
	test("first sign-in shows the bootstrap form pre-filled with email local-part", async ({
		page,
	}) => {
		const localPart = `bs${Date.now().toString(36)}`;
		const email = `${localPart}@kamp.us`;
		await signUp(page, {email});

		// The form should be visible at the root (Layout intercepts Outlet).
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toBeVisible();
		const input = page.locator("input#bootstrap-username");
		await expect(input).toBeVisible();
		// Pre-filled with the email local-part, sanitized to kebab/alnum.
		const sanitized = localPart
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/^-+|-+$/g, "");
		await expect(input).toHaveValue(sanitized);
	});

	test("submitting the bootstrap form sets username + topbar shows @username link", async ({
		page,
	}) => {
		const localPart = `bs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});

		const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const input = page.locator("input#bootstrap-username");
		await input.fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();

		// Bootstrap form gone; topbar shows @username link.
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});
		const profileLink = page.locator('[data-testid="topbar-profile-link"]');
		await expect(profileLink).toBeVisible({timeout: 5_000});
		await expect(profileLink).toContainText(`@${handle}`);
		await expect(profileLink).toHaveAttribute("href", `/u/${handle}`);

		// Click it: should route to /u/<handle> without errors.
		await profileLink.click();
		await expect(page).toHaveURL(`/u/${handle}`, {timeout: 5_000});
	});

	test("client-side validation rejects invalid usernames", async ({page}) => {
		const localPart = `bs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
