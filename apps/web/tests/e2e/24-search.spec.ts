import {expect, test} from "@playwright/test";

/**
 * Search end-to-end (epic #89: resolver #121 + `/search` page #122 + topbar
 * wiring #123, ADR 0080).
 *
 * Runs in the `authed` Playwright project: the `setup` project signs up ONCE and
 * captures the session into storageState (ADR 0085), so each test here starts
 * already logged in — no per-test sign-up. The create steps below act as that
 * shared storageState user.
 *
 * The FTS index is populated ONLY by the app dual-write path on new writes —
 * there is no backfill (#534) and the runner's D1 starts with an EMPTY index.
 * So every spec here **creates content, then searches it**: it adds a sözlük
 * definition to a fresh slug (which auto-creates the term AND syncs its FTS row,
 * `Sozluk.addDefinition` → `syncTermSearch`), then drives the topbar search to
 * query that just-indexed term.
 *
 * A fresh term's title is `slug.replace(/-/g, " ")` — ASCII, since `slugifyTerm`
 * folds Turkish letters away. The ADR-0080 Turkish crux this suite exercises is
 * therefore on the QUERY side: an ASCII title ("gizli") matched by a Turkish
 * variant query ("GİZLİ" / "gizlı"), where `normalizeSearchText` must collapse
 * the dotted-İ and dotless-ı to the same token the index holds.
 */

/** Per-run unique token so each spec's term is brand-new in the (empty) index. */
const nonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Create a sözlük term by adding a first definition to a brand-new slug. Returns
 * the term's stored title (`slug.replace(/-/g, " ")`). Mirrors the
 * 11-sozluk-add-definition flow: the composer at `/sozluk/<slug>` auto-creates
 * the term, and the same write syncs the FTS row the search resolver reads.
 */
async function createTerm(page: import("@playwright/test").Page, slug: string): Promise<string> {
	await page.goto(`/sozluk/${slug}`);
	const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
	await expect(composerBody).toBeVisible({timeout: 10_000});
	await composerBody.fill(`e2e search seed ${Date.now()}`);
	await page.locator('[data-testid="sozluk-composer-submit"]').click();
	// Definition lands → term + FTS row now exist.
	await expect(page.getByText(/e2e search seed/)).toBeVisible({timeout: 10_000});
	return slug.replace(/-/g, " ");
}

/** Submit a query through the topbar search form (the #123 wiring). */
async function topbarSearch(page: import("@playwright/test").Page, query: string): Promise<void> {
	const search = page.locator(".kp-topbar__search input[name='q']");
	await search.fill(query);
	await search.press("Enter");
}

test.describe("Search (/search)", () => {
	test("create-then-search: a freshly-created term appears in topbar search results", async ({
		page,
	}) => {
		const slug = `gizli-${nonce()}`;
		const title = await createTerm(page, slug);

		// Search the exact title via the topbar → navigates to /search?q=… …
		await topbarSearch(page, title);
		await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(title)}`));
		await expect(page.locator(".kp-search__title")).toContainText("arama");

		// …and the created term renders as a TermRow whose title links to its slug.
		const row = page.locator(`.kp-sozluk-term-row[href="/sozluk/${slug}"]`);
		await expect(row).toBeVisible({timeout: 10_000});
		await expect(row.locator(".kp-sozluk-term-row__title")).toContainText(title);
	});

	test("Turkish matching: a dotted/dotless-İ casing variant still matches (ADR 0080)", async ({
		page,
	}) => {
		// Title indexes as ASCII "gizli ..." (slug-with-spaces). The crux: a query
		// that differs only by Turkish casing/diacritics must normalize to the same
		// token the index holds.
		const slug = `gizli-${nonce()}`;
		const title = await createTerm(page, slug);

		// Uppercase the leading "gizli" the Turkish way: "gizli" → "GİZLİ" (dotted İ).
		// `normalizeSearchText` must fold "GİZLİ" → "gizli" to match the indexed term.
		const variant = title.replace(/^gizli/, "GİZLİ");
		expect(variant).not.toBe(title); // guard: the query genuinely differs from the title
		await topbarSearch(page, variant);

		await expect(page).toHaveURL(/\/search\?q=/);
		const row = page.locator(`.kp-sozluk-term-row[href="/sozluk/${slug}"]`);
		await expect(row).toBeVisible({timeout: 10_000});

		// And the dotless-ı diacritic variant ("gizlı") must match too.
		await topbarSearch(page, title.replace(/^gizli/, "gizlı"));
		await expect(page).toHaveURL(/\/search\?q=/);
		await expect(page.locator(`.kp-sozluk-term-row[href="/sozluk/${slug}"]`)).toBeVisible({
			timeout: 10_000,
		});
	});

	test("prefix match: a short prefix of the term matches (prefix indexing)", async ({page}) => {
		const slug = `prefiks-${nonce()}`;
		const title = await createTerm(page, slug); // "prefiks <nonce>"

		// A 3-char prefix of the first token should hit via the `*` suffix the
		// MATCH expression appends (poor-man's stemmer, ADR 0080).
		await topbarSearch(page, "pre");
		await expect(page).toHaveURL(/\/search\?q=pre/);
		await expect(page.locator(`.kp-sozluk-term-row[href="/sozluk/${slug}"]`)).toBeVisible({
			timeout: 10_000,
		});
		// Sanity: the matched row carries the term's title.
		await expect(
			page.locator(`.kp-sozluk-term-row[href="/sozluk/${slug}"] .kp-sozluk-term-row__title`),
		).toContainText(title);
	});

	test("empty state: a query that matches nothing renders the 'sonuç yok' rail, not a blank/crash", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		// The results page is public; this just needs a query that can't match
		// anything in the (empty-seeded) index. (Runs authed harmlessly — the
		// storageState session doesn't change the empty-results path.)
		const miss = `zzqqxx-${nonce()}`;
		await page.goto(`/search?q=${encodeURIComponent(miss)}`);

		const empty = page.locator(".kp-search__empty");
		await expect(empty).toBeVisible({timeout: 10_000});
		await expect(empty).toContainText("sonuç yok");
		// No term rows, no crash.
		await expect(page.locator(".kp-sozluk-term-row")).toHaveCount(0);
		expect(errors).toHaveLength(0);
	});
});
