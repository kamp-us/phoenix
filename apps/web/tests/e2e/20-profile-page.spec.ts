import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Profile page (T14) — `/u/<username>` route + GraphQL `profile(username)`
 * query + interleaved contributions feed.
 *
 * Single author flow:
 *   1. sign up + bootstrap username
 *   2. submit a post → land on /pano/<id>
 *   3. add a comment on the post
 *   4. add a definition on a fresh sozluk slug
 *   5. visit /u/<username> → header counters reflect 1/1/1, three
 *      contribution rows in the feed
 *   6. visit /u/<bogus-username> → 404 page renders
 */
test.describe("Profile page", () => {
	test("aggregates 1 definition + 1 post + 1 comment on /u/<username>", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `pf${suffix}@kamp.us`});
		const handle = `u-${suffix}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// 1) Submit a post.
		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const postTitle = `profile test başlık ${suffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(postTitle);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		// Suspense double-mount reload (do-work artifact) removed —
		// connection-shaped fragments mean the page tree no longer unmounts
		// on mutation, so no reload is needed.
		await expect(page.getByRole("heading", {level: 1})).toContainText(postTitle, {
			timeout: 10_000,
		});
		await expect(page.getByRole("heading", {name: /0 yorum/i})).toBeVisible({timeout: 10_000});

		// 2) Add a comment.
		const commentBody = `profile test yorum ${suffix}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(commentBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 15_000});

		// 3) Add a definition on a fresh slug.
		const slug = `profile-${suffix}`;
		await page.goto(`/sozluk/${slug}`);
		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});
		const definitionBody = `profile test tanımı ${suffix}`;
		await composerBody.fill(definitionBody);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();
		await expect(page.getByText(definitionBody)).toBeVisible({timeout: 10_000});
		// The sozluk composer reloads the page after a successful add (the
		// nested-connection membership reload — fate 1.0.3). The optimistic node can
		// satisfy the assertion above *before* that reload fires, so a `goto` here
		// would race the in-flight reload and abort (`net::ERR_ABORTED`). Wait for
		// the reload to land on the *persisted* definition card (a real `def_<ulid>`
		// id — the optimistic node carries an `optimistic:` id and is gone after the
		// reload re-reads `term(slug)`) before navigating. (We can't
		// `waitForLoadState("networkidle")` — the term page holds a long-lived live
		// SSE stream, so the page is never network-idle.)
		await expect(page.locator('[data-testid^="definition-card-def_"]')).toBeVisible({
			timeout: 10_000,
		});

		// 4) Visit the public profile page.
		await page.goto(`/u/${handle}`);
		await expect(page.getByTestId("user-profile-page")).toBeVisible({timeout: 15_000});
		await expect(page.getByTestId("user-profile-handle")).toContainText(`@${handle}`);

		// Header counters: 1 definition, 1 post, 1 comment.
		await expect(page.getByTestId("stat-definitions")).toContainText("1");
		await expect(page.getByTestId("stat-posts")).toContainText("1");
		await expect(page.getByTestId("stat-comments")).toContainText("1");

		// Feed: three rows, one of each kind.
		await expect(page.getByTestId("contribution-definition")).toHaveCount(1, {timeout: 10_000});
		await expect(page.getByTestId("contribution-post")).toHaveCount(1);
		await expect(page.getByTestId("contribution-comment")).toHaveCount(1);

		// Each row links to its source.
		await expect(
			page.getByTestId("contribution-definition").locator(`a[href="/sozluk/${slug}"]`),
		).toBeVisible();
		await expect(
			page.getByTestId("contribution-post").locator('a[href^="/pano/post_"]'),
		).toBeVisible();
		await expect(
			page.getByTestId("contribution-comment").locator('a[href^="/pano/post_"]'),
		).toBeVisible();
	});

	test("/u/<unknown> renders the 404 page", async ({page}) => {
		const bogus = `nobody-${Date.now().toString(36)}`;
		await page.goto(`/u/${bogus}`);
		await expect(page.getByTestId("not-found-page")).toBeVisible({timeout: 10_000});
		await expect(page.getByRole("heading")).toContainText(/bulunamadı/i);
	});
});
