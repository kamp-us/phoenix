/**
 * The per-letter index (#9267). The seeded `ç` block (`packages/preview-seed`) is 12 headwords
 * against a 10-row page, so the walk here is a real second page — and its order is the Turkish
 * one, which is what the collation exists for.
 */
import {expect, test} from "@playwright/test";

const LETTER = "ç";
const LETTER_PATH = `/sozluk/harf/${encodeURIComponent(LETTER)}`;

const titles = (page: import("@playwright/test").Page) =>
	page.locator(".kp-sozluk-term-row__title").allTextContents();

test.describe("Sözlük letter page (/sozluk/harf/:letter)", () => {
	test("the alphabet strip navigates to the letter's own page and marks it current", async ({
		page,
	}) => {
		await page.goto("/sozluk");
		await expect(page.locator(".kp-sozluk-alphabet")).toBeVisible({timeout: 10_000});

		await page.locator(".kp-sozluk-alphabet__letter", {hasText: new RegExp(`^${LETTER}$`)}).click();

		await expect(page).toHaveURL(new RegExp(`/sozluk/harf/${encodeURIComponent(LETTER)}$`));
		await expect(page.locator(".kp-sozluk-letter__title")).toHaveText("Ç harfi");

		const active = page.locator(".kp-sozluk-alphabet__letter.is-active");
		await expect(active).toHaveText(LETTER);
		await expect(active).toHaveAttribute("aria-current", "page");
	});

	test("lists a first page of the letter's terms and loads a second", async ({page}) => {
		await page.goto(LETTER_PATH);
		await expect(page.locator(".kp-sozluk-term-row").first()).toBeVisible({timeout: 10_000});

		const firstPage = await titles(page);
		expect(firstPage.length).toBe(10);
		for (const title of firstPage) {
			expect(title.toLocaleLowerCase("tr").startsWith(LETTER)).toBe(true);
		}

		const loadMore = page.getByTestId("sozluk-letter-load-more");
		await expect(loadMore).toBeVisible();
		// The control names what it loads, since a screen reader reaches it long after the
		// heading that would otherwise supply the subject.
		await expect(loadMore).toHaveAttribute("aria-label", /Ç/);
		await loadMore.click();

		await expect(page.locator(".kp-sozluk-term-row")).toHaveCount(12);
		await expect(loadMore).toHaveCount(0);
	});

	test("orders the letter by the Turkish alphabet, not by UTF-8 bytes", async ({page}) => {
		await page.goto(LETTER_PATH);
		await expect(page.locator(".kp-sozluk-term-row").first()).toBeVisible({timeout: 10_000});
		await page.getByTestId("sozluk-letter-load-more").click();
		await expect(page.locator(".kp-sozluk-term-row")).toHaveCount(12);

		const rendered = await titles(page);
		// `ı` precedes `i` in Turkish; comparing the two strings by code point says the opposite,
		// so this pair is the whole collation in one assertion.
		expect(rendered.indexOf("çıktı")).toBeLessThan(rendered.indexOf("çizelge"));
		// `ç` is its own letter, so a `ç` page never leaks a `c` headword in either direction.
		expect(rendered.every((t) => t.startsWith("ç"))).toBe(true);
	});

	test("an empty letter says so about the whole corpus, not about a first page", async ({page}) => {
		// No Turkish headword starts with `ğ`, so this letter is empty by construction.
		await page.goto(`/sozluk/harf/${encodeURIComponent("ğ")}`);
		const empty = page.getByTestId("empty-state");
		await expect(empty).toBeVisible({timeout: 10_000});
		await expect(empty).toContainText("harfiyle başlayan terim yok");
		await expect(empty).not.toContainText("ilk sayfada");
	});

	test("a legacy ?harf= link lands on the letter's page", async ({page}) => {
		await page.goto(`/sozluk?harf=${encodeURIComponent(LETTER)}`);
		await expect(page).toHaveURL(new RegExp(`/sozluk/harf/${encodeURIComponent(LETTER)}$`));
		await expect(page.locator(".kp-sozluk-letter__title")).toHaveText("Ç harfi");
	});

	test("a route value that names no letter goes back to the sözlük home", async ({page}) => {
		await page.goto("/sozluk/harf/q");
		await expect(page).toHaveURL(/\/sozluk$/);
		await expect(page.locator(".kp-sozluk-home__title")).toBeVisible({timeout: 10_000});
	});
});
