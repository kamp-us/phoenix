import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {expectScoreConsistent} from "./_helpers/wait-for-consistency";

/**
 * Pano voteOnComment end-to-end.
 *
 * Sign up a fresh user, complete the username bootstrap, submit a brand new
 * post, add a comment, then exercise the optimistic comment-vote flip:
 *   1. Vote → score becomes 1, button reflects pressed state.
 *   2. Click again → retract → score back to 0.
 *   3. Vote again → score 1.
 *
 * The PanoComment vote button uses Relay `optimisticResponse` to flip
 * `myVote` + `score` synchronously; on success the projection lands in <1s
 * and the page reads the new state on subsequent renders.
 *
 * Mirrors `15-pano-vote-post.spec.ts` (post-vote round-trip).
 *
 * The historical `page.reload()` workarounds before vote interactions are
 * gone — `usePaginationFragment` +
 * `commitLocalUpdate` keep the post-detail tree mounted on every mutation
 * and live event, so the Suspense double-mount race they were dodging no
 * longer fires.
 */
test.describe("Pano voteOnComment", () => {
	// QUARANTINED — un-quarantine blocked on #1838 (e2e can't establish yazar tier); see #1903.
	// Vote score-propagation flake tracked at #1903. Tracking: #1885/#1903.
	// The whole test is the comment-vote score round-trip (expectScoreConsistent
	// "0"/"1" + the coupled aria-pressed toggle, which only settles once the score
	// propagates), so the flaky read-back is inseparable from it — fixme'ing the
	// whole test. Lost coverage while quarantined: pano comment vote/unvote/
	// re-vote round-trip. No vote-GATE (#1828) coverage lives here.
	// Re-enable = revert to plain test(...).
	test.fixme("vote → unvote → vote round-trip on a fresh comment", async ({page}) => {
		// Fresh sign-up + bootstrap.
		const localPart = `vc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

		const title = `vote-comment target ${Date.now().toString(36)}`;
		const url = `https://example.com/${Date.now().toString(36)}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(url);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();

		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {
			timeout: 10_000,
		});

		// Wait for the comments boundary to resolve (the "0 yorum" thread heading)
		// before submitting — otherwise the first fetchKey refetch races the initial
		// fetch and the loading fallback can hide the new comment. Mirrors 17/19/20.
		await expect(page.locator(".kp-pano-postpage__thread-heading")).toHaveText("0 yorum", {
			timeout: 10_000,
		});

		// Add a top-level comment.
		const commentBody = `vote target yorum ${Date.now().toString(36)}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(commentBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();

		// Wait for the comment to appear in the tree. Use the thread heading
		// (h2) directly — live updates refetch the post meta after
		// the mutation lands, so both the meta `<span>N yorum</span>` and the
		// thread `<h2>N yorum</h2>` end up rendering "1 yorum" simultaneously.
		await expect(page.locator(".kp-pano-postpage__thread-heading")).toHaveText("1 yorum", {
			timeout: 15_000,
		});

		const voteBtn = page.locator('[data-testid^="comment-vote-"]').first();
		const score = page.locator('[data-testid^="comment-score-"]').first();

		await expect(voteBtn).toBeVisible({timeout: 5_000});
		await expectScoreConsistent(page, score, "0");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "false");

		// Cast vote — optimistic flip lands first.
		await voteBtn.click();
		await expectScoreConsistent(page, score, "1");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true", {timeout: 5_000});

		// Retract.
		await voteBtn.click();
		await expectScoreConsistent(page, score, "0");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "false");

		// Re-vote.
		await voteBtn.click();
		await expectScoreConsistent(page, score, "1");
		await expect(voteBtn).toHaveAttribute("aria-pressed", "true");
	});
});
