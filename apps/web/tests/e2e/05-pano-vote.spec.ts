import {expect, test} from "@playwright/test";
import {completeBootstrap, signUp} from "./_helpers/auth";

/**
 * Pano post-vote toggle. PostVoteWidget tracks a local optimistic delta on
 * top of the server-provided baseScore — so we read the count, click, expect
 * +1, click again, expect a return to baseline. Both transitions go through
 * the Relay mutation; neither should regress on transient flicker because
 * we update React state synchronously before commit.
 *
 * We submit a FRESH post and vote on it (scoped by its unique title) rather
 * than `.kp-pano-post.first()` — the first feed card is the shared seed post
 * (`post-score-seed-post-tanitim`) whose score is mutated by other specs' live
 * updates mid-assert, which flakes the baseline↔+1 round-trip. A brand-new
 * post starts at a quiet score of 0 only this test touches.
 */
test("upvote increments and toggles back (signed in)", async ({page}) => {
	await signUp(page);
	// Clear the username bootstrap gate (a fresh user has no username, so the
	// Layout would otherwise show the bootstrap form in place of the feed).
	await completeBootstrap(page);

	// Submit a fresh post so we vote on a card nothing else is touching.
	await page.goto("/pano/yeni");
	await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 10_000});
	const title = `vote feed target ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	await page
		.locator('[data-testid="pano-submit-url"]')
		.fill(`https://example.com/${Date.now().toString(36)}`);
	await page.locator('[data-testid="pano-submit-title"]').fill(title);
	await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
	const submit = page.locator('[data-testid="pano-submit-submit"]');
	await expect(submit).toBeEnabled({timeout: 5_000});
	await submit.click();
	await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

	// Open the feed, switch to "yeni" (new) so our just-submitted post is on the
	// first page, then locate OUR post by its unique title (not `.first()`).
	await page.goto("/pano");
	await page.getByRole("button", {name: "yeni"}).click();
	const targetPost = page.locator(".kp-pano-post").filter({hasText: title}).first();
	await expect(targetPost).toBeVisible({timeout: 10_000});

	const voteCount = targetPost.locator(".kp-pano-post__vote-count");
	const startText = (await voteCount.textContent())?.trim() ?? "0";
	const start = Number.parseInt(startText, 10);
	expect(Number.isFinite(start)).toBe(true);

	const upvote = targetPost.locator(".kp-pano-post__vote-btn");
	await upvote.click();
	await expect(voteCount).toHaveText(String(start + 1), {timeout: 5_000});
	await expect(upvote).toHaveAttribute("aria-pressed", "true");

	await upvote.click();
	await expect(voteCount).toHaveText(String(start), {timeout: 5_000});
	await expect(upvote).toHaveAttribute("aria-pressed", "false");
});
