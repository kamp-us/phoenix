import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Sözlük voteDefinition end-to-end (task_5).
 *
 * Sign up a fresh user, complete the username bootstrap, navigate to a brand
 * new term URL, write a definition, then exercise the optimistic vote flip:
 *   1. Vote → score becomes 1, button reflects pressed state.
 *   2. Click again → retract vote → score back to 0.
 *   3. Vote again → score 1.
 *
 * The DefinitionCard's optimistic updater flips `myVote` + `score`
 * synchronously; on success the projection lands in <1s and the page reads
 * the new state on subsequent renders.
 */
test.describe("Sözlük voteDefinition (task_5)", () => {
	test("vote → unvote → vote round-trip on a fresh definition", async ({page}) => {
		// Fresh sign-up + bootstrap so the user is fully authenticated.
		const localPart = `vt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Navigate to a fresh slug + add a definition.
		const slug = `vote-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.goto(`/sozluk/${slug}`);

		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});

		const definitionBody = `vote target ${Date.now()}`;
		await composerBody.fill(definitionBody);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();

		// Wait for the new definition to render.
		await expect(page.getByText(definitionBody)).toBeVisible({timeout: 10_000});

		// Find the vote button + score on the only card.
		const voteBtn = page.locator('[data-testid^="definition-vote-"]').first();
		const score = page.locator('[data-testid^="definition-score-"]').first();
		await expect(voteBtn).toBeVisible();
		await expect(score).toHaveText("0");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "false");

		// Cast vote — optimistic flip lands first.
		await voteBtn.click();
		await expect(score).toHaveText("1");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true", {timeout: 5_000});

		// Retract vote.
		await voteBtn.click();
		await expect(score).toHaveText("0", {timeout: 5_000});
		await expect(voteBtn).toHaveAttribute("aria-pressed", "false");

		// Re-vote.
		await voteBtn.click();
		await expect(score).toHaveText("1", {timeout: 5_000});
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true");
	});
});
