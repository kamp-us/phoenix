import {expect, test} from "@playwright/test";
import {slugifyTerm} from "../../src/lib/slugifyTerm";
import {completeBootstrap, signUp} from "./_helpers/auth";

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

/**
 * The create-flow #440 shipped in `SozlukHome.tsx`: both the search-Enter submit
 * (`onSearchSubmit`) and the no-match `"<query>" terimini oluştur` CTA route to the
 * fresh-slug composer at `/sozluk/<slugifyTerm(query)>`. A signed-in user lands on
 * `NewTermComposer` (the `.kp-sozluk-term__head` + composer textarea), so each test
 * signs up first to assert it genuinely reaches the create/composer view, not the
 * signed-out 404. The query is per-run unique so it matches no loaded term — which
 * both forces the no-match CTA to appear and keeps the slug brand-new (composer, not
 * an existing term page).
 */
test.describe("SozlukHome create-flow (/sozluk → composer)", () => {
	test.beforeEach(async ({page}) => {
		await signUp(page);
		await completeBootstrap(page);
		await page.goto("/sozluk");
		await expect(page.locator(".kp-sozluk-home__searchbar input")).toBeVisible({
			timeout: 10_000,
		});
	});

	test("search submit (Enter) routes to /sozluk/<slug> and lands on the composer", async ({
		page,
	}) => {
		const query = `e2e create flow ${Date.now().toString(36)}`;
		const slug = slugifyTerm(query);
		expect(slug).not.toBe("");

		const input = page.locator(".kp-sozluk-home__searchbar input");
		await input.fill(query);
		await input.press("Enter");

		// `onSearchSubmit` navigates to the fresh-slug composer route.
		await expect(page).toHaveURL(new RegExp(`/sozluk/${slug}$`));
		// Signed-in fresh slug → NewTermComposer: term head + composer textarea.
		await expect(page.locator(".kp-sozluk-term__head")).toBeVisible({timeout: 10_000});
		await expect(page.locator('[data-testid="sozluk-composer-body"]')).toBeVisible();
	});

	test("no-match CTA appears for an unknown query and navigates to /sozluk/<slug>", async ({
		page,
	}) => {
		const query = `zzqq nomatch ${Date.now().toString(36)}`;
		const slug = slugifyTerm(query);
		expect(slug).not.toBe("");

		// Typing a query that matches no loaded term flips the recent column to the
		// no-match state, which renders the create CTA (#440).
		await page.locator(".kp-sozluk-home__searchbar input").fill(query);

		const cta = page.locator(".kp-sozluk-home__create-cta");
		await expect(cta).toBeVisible({timeout: 5_000});
		const ctaButton = cta.getByRole("button", {name: /terimini oluştur/i});
		await expect(ctaButton).toBeVisible();

		await ctaButton.click();

		// Same fresh-slug composer route as the search-Enter path.
		await expect(page).toHaveURL(new RegExp(`/sozluk/${slug}$`));
		await expect(page.locator(".kp-sozluk-term__head")).toBeVisible({timeout: 10_000});
		await expect(page.locator('[data-testid="sozluk-composer-body"]')).toBeVisible();
	});
});
