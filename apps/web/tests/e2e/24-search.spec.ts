import {expect, test} from "@playwright/test";

/**
 * Search end-to-end (epic #89: resolver #121 + `/search` page #122 + topbar
 * wiring #123, ADR 0080).
 *
 * Runs in the `unauth` project: these are PUBLIC reads, no session needed. The
 * suite searches terms the preview-seed (`@kampus/preview-seed`) deterministically
 * FTS-indexes, instead of creating one at runtime — the seed dual-writes each
 * fixture's title into `term_search` with the worker's own `normalizeSearchText`,
 * so a seeded title is reliably findable (read-model rows alone aren't searchable,
 * #534). The two seeded terms below are pinned to that fixture set.
 */

/**
 * Pinned to `packages/preview-seed/src/fixtures.ts` — the seed's source of truth.
 * Kept as literals (not imported) so this apps/web spec needs no workspace edge to
 * the seed package; the preview-seed unit tests guard these exact values.
 *   - SEED_TERM_*  → exact-title + prefix assertions ("merhaba dünya" / "merhaba-dunya").
 *   - SEARCH_TERM_* → the Turkish İ/ı fold crux ("ışık" / "isik"): "IŞIK" must match.
 */
const SEED_TERM_SLUG = "merhaba-dunya";
const SEED_TERM_TITLE = "merhaba dünya";
const SEARCH_TERM_SLUG = "isik";
const SEARCH_TERM_TITLE = "ışık";

/** Submit a query through the topbar search form (the #123 wiring). */
async function topbarSearch(page: import("@playwright/test").Page, query: string): Promise<void> {
	const search = page.locator(".kp-topbar__search input[name='q']");
	await search.fill(query);
	await search.press("Enter");
}

test.describe("Search (/search)", () => {
	test("appears: a seeded term's exact title shows its row in topbar search results", async ({
		page,
	}) => {
		await page.goto("/");
		await topbarSearch(page, SEED_TERM_TITLE);

		await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(SEED_TERM_TITLE)}`));
		await expect(page.locator(".kp-search__title")).toContainText("arama");

		const row = page.locator(`.kp-sozluk-term-row[href="/sozluk/${SEED_TERM_SLUG}"]`);
		await expect(row).toBeVisible({timeout: 10_000});
		await expect(row.locator(".kp-sozluk-term-row__title")).toContainText(SEED_TERM_TITLE);
	});

	test("Turkish matching: a dotted/dotless-İ casing variant still matches the seeded term (ADR 0080)", async ({
		page,
	}) => {
		// The seeded title "ışık" indexes (via normalizeSearchText) to "isik". The
		// crux: an uppercase Turkish casing variant ("IŞIK", dotless-I → dotless-ı)
		// must normalize to the same token the index holds.
		const variant = SEARCH_TERM_TITLE.toLocaleUpperCase("tr"); // "ışık" → "IŞIK"
		expect(variant).not.toBe(SEARCH_TERM_TITLE); // guard: the query genuinely differs

		await page.goto("/");
		await topbarSearch(page, variant);
		await expect(page).toHaveURL(/\/search\?q=/);
		await expect(
			page.locator(`.kp-sozluk-term-row[href="/sozluk/${SEARCH_TERM_SLUG}"]`),
		).toBeVisible({timeout: 10_000});
	});

	test("prefix match: a short prefix of a seeded term's title matches (prefix indexing)", async ({
		page,
	}) => {
		// "mer" is a 3-char prefix of "merhaba dünya"'s indexed norm; the MATCH
		// expression's `*` suffix + the FTS `prefix='2 3 4'` index make it hit.
		await page.goto("/");
		await topbarSearch(page, "mer");
		await expect(page).toHaveURL(/\/search\?q=mer/);

		const row = page.locator(`.kp-sozluk-term-row[href="/sozluk/${SEED_TERM_SLUG}"]`);
		await expect(row).toBeVisible({timeout: 10_000});
		await expect(row.locator(".kp-sozluk-term-row__title")).toContainText(SEED_TERM_TITLE);
	});

	test("empty state: a query that matches nothing renders the 'sonuç yok' rail, not a blank/crash", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		const miss = `zzqqxx-${Date.now().toString(36)}`;
		await page.goto(`/search?q=${encodeURIComponent(miss)}`);

		const empty = page.locator(".kp-search__empty");
		await expect(empty).toBeVisible({timeout: 10_000});
		await expect(empty).toContainText("sonuç yok");
		await expect(page.locator(".kp-sozluk-term-row")).toHaveCount(0);
		expect(errors).toHaveLength(0);
	});
});
