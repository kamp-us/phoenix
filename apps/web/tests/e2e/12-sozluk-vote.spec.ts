import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";
import {expectScoreConsistent} from "./_helpers/wait-for-consistency";

/**
 * Sözlük voteDefinition end-to-end.
 *
 * There is deliberately no `page.reload()` between the addDefinition mutation and the vote
 * interactions: the page tree no longer unmounts on a mutation, so a reload reappearing here
 * would signal a regression.
 */
test.describe("Sözlük voteDefinition", () => {
	// QUARANTINED — un-quarantine blocked on #1838 (e2e can't establish yazar tier); see #1903.
	// Vote score-propagation flake tracked at #1903. Tracking: #1885/#1903.
	// The whole test is the definition-vote score round-trip (expectScoreConsistent
	// "0"/"1" + the coupled aria-pressed toggle, which only settles once the score
	// propagates), so the flaky read-back is inseparable from it — fixme'ing the
	// whole test. Lost coverage while quarantined: sözlük definition vote/unvote/
	// re-vote round-trip. No vote-GATE (#1828) coverage lives here.
	// Re-enable = revert to plain test(...).
	test.fixme("vote → unvote → vote round-trip on a fresh definition", async ({page}) => {
		const localPart = `vt${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		const slug = `vote-${Date.now().toString(36)}${randomSuffix(4)}`;
		await page.goto(`/sozluk/${slug}`);

		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});

		const definitionBody = `vote target ${Date.now()}`;
		await composerBody.fill(definitionBody);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();

		// New definition appears via the manual connection updater + the
		// optimistic flip. Re-page-mount happens once for the very
		// first definition on a fresh slug — the page transitions from the
		// "no term yet" branch into the connection branch and reloads to
		// pick up the just-created Term record (the only narrow case left).
		await expect(page.getByText(definitionBody)).toBeVisible({timeout: 15_000});

		const composerBodyAgain = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBodyAgain).toBeVisible({timeout: 10_000});
		await expect(page.getByText(definitionBody)).toBeVisible({timeout: 10_000});

		// Wait for the *persisted* definition card (a real `def_<ulid>` id) — after
		// the fresh-slug reload re-reads `term(slug)` the optimistic `optimistic:`-id
		// node is gone, so binding the vote button to the persisted row avoids voting
		// against a node that's about to be replaced. Mirrors 20's persisted-card guard.
		await expect(page.locator('[data-testid^="definition-card-def_"]').first()).toBeVisible({
			timeout: 10_000,
		});

		const voteBtn = page.locator('[data-testid^="definition-vote-"]').first();
		const score = page.locator('[data-testid^="definition-score-"]').first();
		await expect(voteBtn).toBeVisible({timeout: 5_000});
		await expectScoreConsistent(page, score, "0");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "false");

		await voteBtn.click();
		await expectScoreConsistent(page, score, "1");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true", {timeout: 5_000});

		await voteBtn.click();
		await expectScoreConsistent(page, score, "0");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "false");

		await voteBtn.click();
		await expectScoreConsistent(page, score, "1");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true");
	});
});
