import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Sözlük addDefinition end-to-end.
 *
 * Sign up a fresh user, complete the username bootstrap, navigate to a brand
 * new term URL, write a definition, submit. The new term + definition appear
 * via re-fetched `term(slug)` (auto-create-term behaviour from
 * SozlukTerm.addDefinition).
 *
 * The fresh-slug create is a read-your-own-write seam (#730, epic #713 Family B):
 * the auto-create remounts the content and re-reads `term(slug)` `network-only`,
 * a *second* request that can race the just-committed write. The fix carries
 * `definition.add`'s own returned id across the remount and confirms it via the
 * deterministic read-back, so the **persisted** `definition-card-def_*` card must
 * materialize — asserting on it (not just the body text, which an optimistic echo
 * or a transient render could satisfy) is what guards the race.
 */
test.describe("Sözlük addDefinition", () => {
	test("adding a definition to a new slug auto-creates the term and renders the entry", async ({
		page,
	}) => {
		// Fresh sign-up + bootstrap so the user is fully authenticated.
		const localPart = `bs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Navigate to a slug that doesn't exist yet.
		const slug = `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.goto(`/sozluk/${slug}`);

		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});

		const definitionBody = `e2e definition ${Date.now()}`;
		await composerBody.fill(definitionBody);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();

		// New definition body is visible — necessary but not sufficient (the body text
		// alone can be satisfied by a transient render before the persisted node lands).
		await expect(page.getByText(definitionBody)).toBeVisible({timeout: 10_000});

		// The race guard: the **persisted** definition card (real `def_<ulid>` id) must
		// materialize on the fresh-slug remount. Before #730 the remount's blind
		// `network-only` re-read could race the write and silently drop this card; the
		// mutation's own returned id, confirmed via the read-back, makes it deterministic.
		await expect(page.locator('[data-testid^="definition-card-def_"]').first()).toBeVisible({
			timeout: 10_000,
		});

		// The term head shows the slug-derived title and a "1 tanım" counter.
		await expect(page.getByRole("heading", {level: 1})).toContainText(slug.replace(/-/g, " "));
	});

	test("submit is disabled for empty body and surfaces an error for >10000 chars", async ({
		page,
	}) => {
		const localPart = `bs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		const slug = `e2e-validate-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.goto(`/sozluk/${slug}`);

		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		const submit = page.locator('[data-testid="sozluk-composer-submit"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});

		// Empty body → submit disabled.
		await expect(submit).toBeDisabled();

		// Whitespace-only → still disabled (trim).
		await composerBody.fill("   ");
		await expect(submit).toBeDisabled();

		// Body length over 10 000 → length warning visible.
		await composerBody.fill("x".repeat(10_001));
		await expect(page.getByText(/en fazla 10000 karakter/i)).toBeVisible();
	});
});
