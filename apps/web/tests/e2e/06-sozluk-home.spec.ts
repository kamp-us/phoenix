import {expect, test} from "@playwright/test";
import {slugifyTerm} from "../../src/lib/slugifyTerm";
import {completeBootstrap, signUp} from "./_helpers/auth";

test.describe("SozlukHome (/sozluk)", () => {
	test.beforeEach(async ({page}) => {
		await page.goto("/sozluk");
		await expect(page.locator(".kp-sozluk-home__title")).toBeVisible({timeout: 10_000});
	});

	test("masthead title + create CTA + alphabet visible", async ({page}) => {
		await expect(page.locator(".kp-sozluk-home__title")).toContainText("sözlük");
		// The CTA and the alphabet live in sözlük's persistent Subnav zone (#2602), not the
		// masthead — the page paints neither a second time.
		await expect(page.getByRole("button", {name: /yeni tanım/i})).toBeVisible();
		await expect(page.locator(".kp-sozluk-alphabet")).toBeVisible();
		// Each non-empty letter is a navigable link to `/sozluk?harf=<letter>` (#693):
		// at least one such link renders (the index isn't all-inert).
		const links = page.locator('.kp-sozluk-alphabet__letter[href*="harf="]');
		expect(await links.count()).toBeGreaterThan(0);
	});

	test("recent and popular columns render rows", async ({page}) => {
		await expect(page.locator(".kp-sozluk-term-row").first()).toBeVisible({timeout: 10_000});
		const popular = page.locator(".kp-sozluk-popular__row");
		expect(await popular.count()).toBeGreaterThan(0);
		await expect(popular.first().locator(".kp-sozluk-popular__rank")).toBeVisible();
		await expect(popular.first().locator(".kp-sozluk-popular__meta")).toBeVisible();
	});

	// There is no typed-query filter test: that search folded into the global ⌘K `ara`
	// (#2995, covered by 24-search.spec.ts), leaving only the letter filter below.

	test("clicking an alphabet letter navigates to ?harf= and filters the recent column", async ({
		page,
	}) => {
		const firstLetter = page.locator('.kp-sozluk-alphabet__letter[href*="harf="]').first();
		const letter = (await firstLetter.textContent())?.trim().toLowerCase() ?? "";
		await firstLetter.click();
		await expect(page).toHaveURL(new RegExp(`[?&]harf=${encodeURIComponent(letter)}(&|$)`));
		const activeLetter = page.locator(".kp-sozluk-alphabet__letter.is-active");
		await expect(activeLetter).toHaveAttribute("aria-current", "page");
		await expect(activeLetter).toHaveText(letter);
		// Either rows remain (all starting with that letter), or the column is empty.
		const titles = await page.locator(".kp-sozluk-term-row__title").allTextContents();
		for (const t of titles) {
			expect(t.toLowerCase().startsWith(letter)).toBe(true);
		}
	});
});

/**
 * The create-flow (#440/#97). Signs up first because a signed-out fresh slug renders a 404,
 * not the composer. The term is per-run unique to keep the slug brand-new — an existing slug
 * would render the term page instead.
 */
test.describe("SozlukHome create-flow (+ yeni tanım → composer)", () => {
	test.beforeEach(async ({page}) => {
		await signUp(page);
		await completeBootstrap(page);
		await page.goto("/sozluk");
		await expect(page.getByRole("button", {name: /yeni tanım/i})).toBeVisible({timeout: 10_000});
	});

	test("+ yeni tanım dialog routes a fresh term to /sozluk/<slug> and lands on the composer", async ({
		page,
	}) => {
		const term = `e2e create flow ${Date.now().toString(36)}`;
		const slug = slugifyTerm(term);
		expect(slug).not.toBe("");

		await page.getByRole("button", {name: /yeni tanım/i}).click();

		// Matched by role, not a BEM class: the Manti migration made Dialog a straight
		// re-export, so nothing emits the old `.kp-dialog__popup`.
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await page.getByLabel("Terim").fill(term);
		await page.getByRole("button", {name: /^oluştur$/i}).click();
		await expect(page).toHaveURL(new RegExp(`/sozluk/${slug}$`));
		await expect(page.locator(".kp-sozluk-term__head")).toBeVisible({timeout: 10_000});
		await expect(page.locator('[data-testid="sozluk-composer-body"]')).toBeVisible();
	});
});
