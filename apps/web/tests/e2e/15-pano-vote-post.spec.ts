import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {expectScoreConsistent} from "./_helpers/wait-for-consistency";

/**
 * Pano voteOnPost end-to-end.
 *
 * Sign up a fresh user, complete the username bootstrap, submit a brand new
 * post, navigate to its detail page, then exercise the optimistic vote flip:
 *   1. Vote → score becomes 1, button reflects pressed state.
 *   2. Click again → retract vote → score back to 0.
 *   3. Vote again → score 1.
 *
 * The PostVoteWidget's `optimisticResponse` flips `myVote` + `score`
 * synchronously; on success the projection lands in <1s and the page reads
 * the new state on subsequent renders.
 *
 * Mirrors `12-sozluk-vote.spec.ts`. After the relay-idiom refactor
 * the page tree no longer unmounts on submitPost / vote mutations,
 * so the historical `page.reload()` Suspense workaround is gone.
 */
test.describe("Pano voteOnPost", () => {
	test("vote → unvote → vote round-trip on a fresh post", async ({page}) => {
		// Fresh sign-up + bootstrap so the user is fully authenticated.
		const localPart = `vp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Submit a brand-new post and let the page navigate to /pano/<id>.
		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({
			timeout: 10_000,
		});

		const title = `vote target başlık ${Date.now().toString(36)}`;
		const body = "vote round-trip için yazılmış başlık";
		const url = `https://example.com/${Date.now().toString(36)}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(url);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-body"]').fill(body);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();

		// Wait for the post id URL — exclude `/pano/yeni` (the submit page) by
		// matching only post-id-shaped paths (`post_<ulid>`).
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {
			timeout: 10_000,
		});

		const voteBtn = page.locator('[data-testid^="post-vote-"]').first();
		const score = page.locator('[data-testid^="post-score-"]').first();

		await expect(voteBtn).toBeVisible({timeout: 5_000});
		await expect(score).toHaveText("0");
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
