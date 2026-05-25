import {expect, test} from "@playwright/test";
import {completeBootstrap, signUp} from "./_helpers/auth";

/**
 * Pano post-vote toggle. PostVoteWidget tracks a local optimistic delta on
 * top of the server-provided baseScore — so we read the count, click, expect
 * +1, click again, expect a return to baseline. Both transitions go through
 * the Relay mutation; neither should regress on transient flicker because
 * we update React state synchronously before commit.
 */
test("upvote increments and toggles back (signed in)", async ({page}) => {
	await signUp(page);
	// Clear the username bootstrap gate (a fresh user has no username, so the
	// Layout would otherwise show the bootstrap form in place of the feed).
	await completeBootstrap(page);
	await page.goto("/pano");
	const firstPost = page.locator(".kp-pano-post").first();
	await expect(firstPost).toBeVisible({timeout: 10_000});

	const voteCount = firstPost.locator(".kp-pano-post__vote-count");
	const startText = (await voteCount.textContent())?.trim() ?? "0";
	const start = Number.parseInt(startText, 10);
	expect(Number.isFinite(start)).toBe(true);

	const upvote = firstPost.locator(".kp-pano-post__vote-btn");
	await upvote.click();
	await expect(voteCount).toHaveText(String(start + 1), {timeout: 5_000});
	await expect(upvote).toHaveAttribute("aria-pressed", "true");

	await upvote.click();
	await expect(voteCount).toHaveText(String(start), {timeout: 5_000});
	await expect(upvote).toHaveAttribute("aria-pressed", "false");
});
