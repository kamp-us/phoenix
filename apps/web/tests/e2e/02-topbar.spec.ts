import {expect, test} from "@playwright/test";
import {signOut, signUp} from "./_helpers/auth";

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

	test("tema button toggles <html data-theme>", async ({page}) => {
		const html = page.locator("html");
		const initial = await html.getAttribute("data-theme");
		expect(initial).toMatch(/^(dark|light)$/);

		await page.getByRole("button", {name: /^tema$/i}).click();
		const next = initial === "dark" ? "light" : "dark";
		await expect(html).toHaveAttribute("data-theme", next);

		await page.getByRole("button", {name: /^tema$/i}).click();
		await expect(html).toHaveAttribute("data-theme", initial ?? "dark");
	});

	test("search box focuses + has ⌘K hint + submitting does not error", async ({page}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		const search = page.locator(".kp-topbar__search input[name='q']");
		await search.focus();
		await expect(search).toBeFocused();
		await expect(page.locator(".kp-topbar__search kbd")).toContainText("⌘K");

		await search.fill("hello");
		await search.press("Enter");
		// no nav, no error
		await expect(page.locator(".kp-topbar")).toBeVisible();
		expect(errors).toHaveLength(0);
	});

	test("signed-out: + giriş yap visible, no user pill", async ({page}) => {
		await expect(page.getByRole("button", {name: /giriş yap/i}).first()).toBeVisible();
		await expect(page.locator(".kp-topbar__user")).toHaveCount(0);
	});
});

test.describe("Topbar (signed in)", () => {
	test("+ gönderi button + user pill visible after sign-up", async ({page}) => {
		const creds = await signUp(page);
		await expect(page.getByRole("button", {name: /\+ gönderi/i})).toBeVisible();
		const pill = page.locator(".kp-topbar__user");
		await expect(pill).toBeVisible();
		await expect(pill).toContainText(creds.name);
		await signOut(page);
	});
});
