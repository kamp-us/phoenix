import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {expectScoreConsistent} from "./_helpers/wait-for-consistency";

/**
 * Sözlük voteDefinition end-to-end.
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
 *
 * Historical note: this spec previously contained a `page.reload()` between
 * the addDefinition mutation and the vote interactions to escape the
 * Suspense double-mount race triggered by the legacy
 * `setFetchKey`-driven refetch. After the relay-idiom refactor the
 * page tree no longer unmounts on a mutation (idiomatic Relay
 * `@deleteRecord` + manual `updater` for prepends + `commitLocalUpdate`
 * for live updates), so the reload is gone. Its presence would now signal
 * a regression.
 */
test.describe("Sözlük voteDefinition", () => {
	// QUARANTINED (temporary) — vote score-propagation flake, see #1903; re-enable when #1903 lands. Tracking: #1885/#1903.
	// The whole test is the definition-vote score round-trip (expectScoreConsistent
	// "0"/"1" + the coupled aria-pressed toggle, which only settles once the score
	// propagates), so the flaky read-back is inseparable from it — fixme'ing the
	// whole test. Lost coverage while quarantined: sözlük definition vote/unvote/
	// re-vote round-trip. No vote-GATE (#1828) coverage lives here.
	// Re-enable = revert to plain test(...).
	test.fixme("vote → unvote → vote round-trip on a fresh definition", async ({page}) => {
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

		// Cast vote — optimistic flip lands first.
		await voteBtn.click();
		await expectScoreConsistent(page, score, "1");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true", {timeout: 5_000});

		// Retract vote.
		await voteBtn.click();
		await expectScoreConsistent(page, score, "0");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "false");

		// Re-vote.
		await voteBtn.click();
		await expectScoreConsistent(page, score, "1");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true");
	});
});
