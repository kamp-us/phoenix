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

	// The three-way picker is the sole theme control (#2612) — a signed-out visitor reaches
	// it in the topbar's utility zone (a signed-in one gets it in the user menu instead).
	test("theme picker sets <html data-theme>", async ({page}) => {
		const html = page.locator("html");
		const picker = page.getByTestId("topbar-theme-picker");
		await expect(picker).toBeVisible();

		await picker.getByRole("radio", {name: /^koyu$/i}).click();
		await expect(html).toHaveAttribute("data-theme", "dark");

		await picker.getByRole("radio", {name: /^açık$/i}).click();
		await expect(html).toHaveAttribute("data-theme", "light");
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
