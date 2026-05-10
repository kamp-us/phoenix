import {expect, test} from "@playwright/test";

test.describe("SozlukHome (/sozluk)", () => {
	test.beforeEach(async ({page}) => {
		await page.goto("/sozluk");
		await expect(page.locator(".kp-sozluk-home__title")).toBeVisible({timeout: 10_000});
	});

	test("masthead title + searchbar + alphabet visible", async ({page}) => {
		await expect(page.locator(".kp-sozluk-home__title")).toContainText("sözlük");
		await expect(page.locator(".kp-sozluk-home__searchbar input")).toBeVisible();
		await expect(page.locator(".kp-sozluk-alphabet")).toBeVisible();
		// at least one letter is a clickable button (not all empty)
		const buttons = page.locator(".kp-sozluk-alphabet__letter[aria-pressed]");
		expect(await buttons.count()).toBeGreaterThan(0);
	});

	test("recent and popular columns render rows", async ({page}) => {
		// At least one term row in "son eklenenler"
		await expect(page.locator(".kp-sozluk-term-row").first()).toBeVisible({timeout: 10_000});
		// Popular list with rank + score format
		const popular = page.locator(".kp-sozluk-popular__row");
		expect(await popular.count()).toBeGreaterThan(0);
		await expect(popular.first().locator(".kp-sozluk-popular__rank")).toBeVisible();
		await expect(popular.first().locator(".kp-sozluk-popular__meta")).toBeVisible();
	});

	test("search filters in real time", async ({page}) => {
		const firstTitle = page.locator(".kp-sozluk-term-row__title").first();
		const titleText = (await firstTitle.textContent())?.trim() ?? "";
		// Pick a substring distinctive enough to narrow the list. Take the
		// first word; if it's too short, fall back to the full title.
		const word = titleText.split(/\s+/)[0] ?? titleText;
		const needle = word.length >= 3 ? word.toLowerCase() : titleText.toLowerCase();

		const totalBefore = await page.locator(".kp-sozluk-term-row").count();
		await page.locator(".kp-sozluk-home__searchbar input").fill(needle);
		// SozlukHomeChrome filters synchronously on setQuery — no debounce.
		await expect
			.poll(async () => page.locator(".kp-sozluk-term-row").count(), {timeout: 3_000})
			.toBeLessThanOrEqual(totalBefore);
		const remaining = page.locator(".kp-sozluk-term-row");
		expect(await remaining.count()).toBeGreaterThan(0);
		// Every remaining title should contain the needle (case-insensitive).
		for (const t of await remaining.locator(".kp-sozluk-term-row__title").allTextContents()) {
			expect(t.toLowerCase()).toContain(needle);
		}
	});

	test("clicking an alphabet letter filters the recent column", async ({page}) => {
		// Pick the first non-empty letter and click it.
		const firstLetter = page.locator(".kp-sozluk-alphabet__letter[aria-pressed]").first();
		const letter = (await firstLetter.textContent())?.trim().toLowerCase() ?? "";
		await firstLetter.click();
		await expect(firstLetter).toHaveAttribute("aria-pressed", "true");
		// Either rows remain (all starting with that letter), or the column is empty.
		const titles = await page.locator(".kp-sozluk-term-row__title").allTextContents();
		for (const t of titles) {
			expect(t.toLowerCase().startsWith(letter)).toBe(true);
		}
	});
});
