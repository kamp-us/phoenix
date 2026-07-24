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
		// The local go-to search box is gone — folded into the global ⌘K `ara` (#2995). The
		// `+ yeni tanım` create CTA and the alphabet both live in sözlük's persistent Subnav
		// zone (#2602), not the masthead — the page paints neither a second time.
		await expect(page.getByRole("button", {name: /yeni tanım/i})).toBeVisible();
		await expect(page.locator(".kp-sozluk-alphabet")).toBeVisible();
		// Each non-empty letter is a navigable link to `/sozluk?harf=<letter>` (#693):
		// at least one such link renders (the index isn't all-inert).
		const links = page.locator('.kp-sozluk-alphabet__letter[href*="harf="]');
		expect(await links.count()).toBeGreaterThan(0);
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

	// The in-page real-time typed-query filter was removed by design (#2995): the
	// "go to a term" search folded into the global ⌘K `ara` → `/search` (covered by
	// 24-search.spec.ts), leaving only the URL-driven alphabet letter filter below.

	test("clicking an alphabet letter navigates to ?harf= and filters the recent column", async ({
		page,
	}) => {
		// Letters are navigable links now (#693): clicking pushes `/sozluk?harf=<letter>`,
		// and the recent column filters client-side off that URL param.
		const firstLetter = page.locator('.kp-sozluk-alphabet__letter[href*="harf="]').first();
		const letter = (await firstLetter.textContent())?.trim().toLowerCase() ?? "";
		await firstLetter.click();
		// The click is a real navigation: the active letter is reflected in the URL…
		await expect(page).toHaveURL(new RegExp(`[?&]harf=${encodeURIComponent(letter)}(&|$)`));
		// …and marked active (aria-current + .is-active) rather than a transient toggle.
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
 * The create-flow #440/#97: the old go-to-or-create box's search half folded into the
 * global ⌘K `ara` (#2995), leaving the create half as the `+ yeni tanım` CTA
 * (`SozlukSubnavCta`). It opens a dialog that slugifies the typed term and routes to the
 * fresh-slug composer at `/sozluk/<slugifyTerm(term)>` — the same target the old box
 * reached. A signed-in user lands on `NewTermComposer` (the `.kp-sozluk-term__head` +
 * composer body), so the test signs up first to assert it genuinely reaches the composer
 * view, not the signed-out 404. The term is per-run unique to keep the slug brand-new (a
 * composer, not an existing term page).
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

		// The reopen-retry workaround is retired (#3840): #3600 pinned the silent closer as an
		// ancestor unmount resetting the CTA's local `open` useState, and #3840 hoisted that
		// state above the unmounting boundary — so the dialog no longer vanishes on an idle
		// `/sozluk`, and the flow is a straight open → fill → submit → navigate.
		const dialog = page.locator(".kp-dialog__popup");
		await expect(dialog).toBeVisible();
		// The dialog collects the term name (the composer is slug-addressed).
		await page.getByLabel("Terim").fill(term);
		await page.getByRole("button", {name: /^oluştur$/i}).click();
		// The dialog slugifies + navigates to the fresh-slug composer route.
		await expect(page).toHaveURL(new RegExp(`/sozluk/${slug}$`));
		// Signed-in fresh slug → NewTermComposer: term head + composer body.
		await expect(page.locator(".kp-sozluk-term__head")).toBeVisible({timeout: 10_000});
		await expect(page.locator('[data-testid="sozluk-composer-body"]')).toBeVisible();
	});
});
