import {expect, test} from "@playwright/test";

test.describe("Topbar (signed out)", () => {
	test.beforeEach(async ({page}) => {
		await page.goto("/");
	});

	test("brand routes back to /", async ({page}) => {
		await page.goto("/pano");
		await page.locator(".kp-topbar__brand").click();
		await expect(page).toHaveURL("/");
	});

	test("nav links route correctly with aria-current on active", async ({page}) => {
		await page.locator(".kp-topbar__nav a", {hasText: /^pano$/i}).click();
		await expect(page).toHaveURL("/pano");
		await expect(page.locator(".kp-topbar__nav a", {hasText: /^pano$/i})).toHaveAttribute(
			"aria-current",
			"page",
		);

		await page.locator(".kp-topbar__nav a", {hasText: /^sözlük$/i}).click();
		await expect(page).toHaveURL("/sozluk");
		await expect(page.locator(".kp-topbar__nav a", {hasText: /^sözlük$/i})).toHaveAttribute(
			"aria-current",
			"page",
		);
	});

	// Signed out there is no theme control; the page follows the OS (ADR 0437).
	test("no theme picker, and <html data-theme> follows the OS", async ({page}) => {
		await expect(page.getByTestId("topbar-theme-picker")).toHaveCount(0);

		const html = page.locator("html");
		await page.emulateMedia({colorScheme: "light"});
		await expect(html).toHaveAttribute("data-theme", "light");
		await page.emulateMedia({colorScheme: "dark"});
		await expect(html).toHaveAttribute("data-theme", "dark");
	});

	test("search trigger has the ⌘K hint and opens the palette by click and by shortcut", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		const trigger = page.locator("#topbar-search");
		await expect(trigger.locator("kbd")).toContainText("⌘K");

		const palette = page.getByRole("dialog");
		const field = palette.getByRole("combobox");
		await trigger.click();
		await expect(field).toBeFocused();
		await field.fill("hello");
		await field.press("Escape");
		await expect(palette).toBeHidden();

		await page.keyboard.press("ControlOrMeta+k");
		await expect(field).toBeFocused();
		await expect(page.locator(".kp-topbar")).toBeVisible();
		expect(errors).toHaveLength(0);
	});
});

// The signed-in user pill and the signed-out `giriş yap` state are proven across a real sign-up
// and sign-out by `08-auth.spec.ts`.
