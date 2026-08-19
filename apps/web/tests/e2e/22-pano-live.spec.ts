import {type BrowserContext, expect, type Page, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {promoteToYazar} from "./_helpers/promote";
import {randomSuffix} from "./_helpers/rand";

declare global {
	interface Window {
		/** Sentinel set in-page to detect a full reload (a reload would clear it). */
		__noReload?: boolean;
	}
}

/**
 * Two-client live propagation over SSE (see ADR 0023, ADR 0037).
 *
 * Two real browser contexts, so the events genuinely cross the isolate
 * boundary through the DO — an in-memory bus could not. No `page.reload()` on
 * the observer: if the row appears, it arrived live.
 */

/**
 * Sign up + clear the username bootstrap gate on an arbitrary page/context.
 * Returns the sign-up `email` — the stable handle a spec needs to promote the
 * user's authorship tier over D1 (`promoteToYazar`), since the UI sign-up flow
 * doesn't surface the assigned user id.
 */
async function signUpAndBootstrap(page: Page): Promise<{email: string}> {
	const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
	const email = `live${suffix}@kamp.us`;
	await signUp(page, {email});
	await page.locator("input#bootstrap-username").fill(`lv-${suffix}`);
	await page.getByRole("button", {name: /devam et/i}).click();
	await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
		timeout: 10_000,
	});
	return {email};
}

async function submitPost(page: Page, title: string): Promise<string> {
	await page.goto("/pano/yeni");
	await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 10_000});
	await page
		.locator('[data-testid="pano-submit-url"]')
		.fill(`https://example.com/${Date.now().toString(36)}`);
	await page.locator('[data-testid="pano-submit-title"]').fill(title);
	await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
	// The submit button stays disabled until title (≥ min length) + a tag are set;
	// wait for it to enable so the click can't race the controlled-input updates.
	const submit = page.locator('[data-testid="pano-submit-submit"]');
	await expect(submit).toBeEnabled({timeout: 5_000});
	await submit.click();
	await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
	await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});
	return new URL(page.url()).pathname;
}

test.describe("Pano live (two clients)", () => {
	test("comment + post-vote propagate to a second client without refetch", async ({browser}) => {
		const ctxA: BrowserContext = await browser.newContext();
		const ctxB: BrowserContext = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		try {
			const {email: emailA} = await signUpAndBootstrap(pageA);
			const {email: emailB} = await signUpAndBootstrap(pageB);
			// A casts a post-vote on B's post below. Self-voting is blocked (#2216), so the
			// voter can't author the target: B creates the post, A votes it. Promote A past the
			// anti-manipulation vote-gate (#1828/#1810, ADR 0137) and B so its post is live
			// (not sandboxed) and thus votable.
			await promoteToYazar(emailA);
			await promoteToYazar(emailB);

			const stamp = `${Date.now().toString(36)}${randomSuffix(3)}`;
			const title = `live target ${stamp}`;
			const postPath = await submitPost(pageB, title);
			await expect(pageB.locator(".kp-pano-postpage__thread-heading")).toHaveText("0 yorum", {
				timeout: 10_000,
			});

			await pageA.goto(postPath);
			await expect(pageA.getByRole("heading", {level: 1})).toContainText(title, {
				timeout: 10_000,
			});
			await expect(pageA.locator('[data-testid="pano-comment-input"]')).toBeVisible({
				timeout: 10_000,
			});

			const commentBody = `live yorum ${stamp}`;
			await pageA.locator('[data-testid="pano-comment-input"]').fill(commentBody);
			await pageA.locator('[data-testid="pano-comment-submit"]').click();

			await expect(pageB.getByText(commentBody, {exact: false}).first()).toBeVisible({
				timeout: 15_000,
			});
			await expect(pageB.locator(".kp-pano-postpage__thread-heading")).toHaveText("1 yorum", {
				timeout: 15_000,
			});

			const scoreB = pageB.locator('[data-testid^="post-score-"]').first();
			const voteBtnA = pageA.locator('[data-testid^="post-vote-"]').first();
			await expect(voteBtnA).toBeVisible({timeout: 5_000});
			await voteBtnA.click();

			await expect(scoreB).toHaveText("1", {timeout: 15_000});
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});

	test("after a reconnect the active post view resubscribes and resumes live", async ({
		browser,
	}) => {
		const ctxA: BrowserContext = await browser.newContext();
		const ctxB: BrowserContext = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		try {
			const {email: emailA} = await signUpAndBootstrap(pageA);
			const {email: emailB} = await signUpAndBootstrap(pageB);
			// A casts post-votes on B's post below. Self-voting is blocked (#2216), so the
			// voter can't author the target: B creates the post, A votes it. Promote A past the
			// anti-manipulation vote-gate (#1828/#1810, ADR 0137) and B so its post is live/votable.
			await promoteToYazar(emailA);
			await promoteToYazar(emailB);

			const stamp = `${Date.now().toString(36)}${randomSuffix(3)}`;
			const title = `reconnect target ${stamp}`;
			const postPath = await submitPost(pageB, title);

			await pageA.goto(postPath);
			await expect(pageA.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});

			// A votes WHILE B is "away" (the reload below tears down B's SSE stream
			// and rebuilds it). v1 resumes live-only — the event A sends during the
			// gap is NOT replayed; B reconciles it on the next cache read (the reload
			// re-fetches), then resumes live for subsequent events.
			const voteBtnA = pageA.locator('[data-testid^="post-vote-"]').first();
			await expect(voteBtnA).toBeVisible({timeout: 5_000});
			await voteBtnA.click();

			await pageB.reload();
			await expect(pageB.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});
			const scoreB = pageB.locator('[data-testid^="post-score-"]').first();
			await expect(scoreB).toHaveText("1", {timeout: 10_000});

			let bFateRequests = 0;
			pageB.on("request", (req) => {
				if (req.method() === "POST" && new URL(req.url()).pathname === "/fate") {
					bFateRequests += 1;
				}
			});
			await pageB.waitForTimeout(1_000); // let the resubscribe settle
			await voteBtnA.click();
			await expect(scoreB).toHaveText("0", {timeout: 15_000});
			// The post-detail also subscribes its comment list + header on mount, so
			// the only `/fate` request that could fire is a re-fetch — assert none did
			// between the resubscribe and the score change → it arrived live.
			expect(bFateRequests).toBe(0);
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});

	/**
	 * Single-client on purpose: the author's own view is driven by the same
	 * server event a second client gets, so this sidesteps the two-client SSE
	 * flakiness above. The no-reload proof is the `__noReload` window sentinel.
	 */
	test("definition add/delete + comment delete update in place without a reload", async ({
		page,
	}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUpAndBootstrap(page);

		const slug = `live-def-${suffix}`;
		await page.goto(`/sozluk/${slug}`);
		await expect(page.locator('[data-testid="sozluk-composer-body"]')).toBeVisible({
			timeout: 10_000,
		});
		// First add on a fresh slug auto-creates the term and flips to the list
		// branch (a network-only remount, not a full reload).
		const firstDef = `ilk tanım ${suffix}`;
		await page.locator('[data-testid="sozluk-composer-body"]').fill(firstDef);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();
		await expect(page.getByText(firstDef, {exact: false})).toBeVisible({timeout: 15_000});
		// Wait for the *persisted* card (real `def_<ulid>` id) so the fresh-slug
		// term-materialization remount has fully landed before we drop the sentinel —
		// otherwise that remount fires AFTER the sentinel and wipes it, failing the
		// no-reload check below for the wrong reason. Mirrors 20's persisted-card guard.
		await expect(page.locator('[data-testid^="definition-card-def_"]').first()).toBeVisible({
			timeout: 10_000,
		});

		await page.evaluate(() => {
			window.__noReload = true;
		});
		const secondDef = `ikinci tanım ${suffix}`;
		await page.locator('[data-testid="sozluk-composer-body"]').fill(secondDef);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();
		await expect(page.getByText(secondDef, {exact: false})).toBeVisible({timeout: 15_000});
		expect(await page.evaluate(() => window.__noReload === true)).toBe(true);

		const secondCard = page
			.locator('[data-testid^="definition-card-"]')
			.filter({hasText: secondDef});
		await expect(secondCard).toBeVisible({timeout: 10_000});
		const defId = (await secondCard.getAttribute("data-testid"))!.replace("definition-card-", "");
		// The delete button lives inside the card; the confirm dialog portals to the
		// document body, so resolve it off the page.
		await page.locator(`[data-testid="definition-delete-${defId}"]`).click();
		const defConfirm = page.locator(`[data-testid="definition-delete-confirm-${defId}"]`);
		await expect(defConfirm).toBeVisible({timeout: 5_000});
		await defConfirm.click();
		await expect(page.getByText(secondDef, {exact: false})).toHaveCount(0, {timeout: 15_000});
		expect(await page.evaluate(() => window.__noReload === true)).toBe(true);
		await expect(page.getByText(firstDef, {exact: false})).toBeVisible();

		const postPath = await submitPost(page, `live target ${suffix}`);
		await expect(page.locator('[data-testid="pano-comment-input"]')).toBeVisible({
			timeout: 10_000,
		});
		const commentBody = `silinecek yorum ${suffix}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(commentBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 15_000});
		await expect(page.getByText(commentBody, {exact: false}).first()).toBeVisible({
			timeout: 10_000,
		});

		// Sentinel again (this page navigated, so re-set it).
		await page.evaluate(() => {
			window.__noReload = true;
		});
		const voteBtn = page.locator('[data-testid^="comment-vote-comm_"]').first();
		await expect(voteBtn).toBeVisible({timeout: 10_000});
		const commentId = (await voteBtn.getAttribute("data-testid"))!.replace("comment-vote-", "");
		await page.locator(`[data-testid="pano-comment-menu-${commentId}"]`).click();
		await page.locator(`[data-testid="pano-comment-delete-trigger-${commentId}"]`).click();
		await expect(page.locator('[data-testid="pano-comment-delete-confirm"]')).toBeVisible({
			timeout: 5_000,
		});
		await page.locator('[data-testid="pano-comment-delete-confirm"]').click();

		await expect(page.getByText(commentBody, {exact: false})).toHaveCount(0, {timeout: 15_000});
		await expect(page.getByRole("heading", {name: /0 yorum/i})).toBeVisible({timeout: 15_000});
		expect(await page.evaluate(() => window.__noReload === true)).toBe(true);
		expect(new URL(page.url()).pathname).toBe(postPath);
	});

	test("a new post appears in a second client's open feed without refetch", async ({browser}) => {
		const ctxA: BrowserContext = await browser.newContext();
		const ctxB: BrowserContext = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		try {
			const {email: emailA} = await signUpAndBootstrap(pageA);
			await signUpAndBootstrap(pageB);
			// A authors the post B must SEE, so A has to be live: a çaylak's post is
			// stamped `sandboxed_at` and read-masked from every viewer but its author, so
			// the row would never reach B's feed and the live fan-out under test could not
			// be observed. Only A is promoted — B stays a fresh çaylak, keeping the
			// newcomer-as-reader path covered (ADR 0137).
			await promoteToYazar(emailA);

			// Client B opens the default feed (`sıcak`/hot) and waits for it to
			// settle so the live `posts` connection is subscribed. A `post.submit`
			// publishes `prependNode` to the *global* `posts` topic, which every
			// feed-sort subscription (incl. this filtered one) is registered under.
			await pageB.goto("/pano");
			await expect(pageB.locator(".kp-pano-list")).toBeVisible({timeout: 10_000});
			await expect(pageB.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
			// Give the initial feed request + live `subscribeConnection` control POST
			// time to settle so the subscription is registered before A submits. (We
			// can't `waitForLoadState("networkidle")` — the live SSE stream is a
			// long-lived request, so the page is never network-idle.)
			await pageB.waitForTimeout(1_500);
			let bFateRequests = 0;
			pageB.on("request", (req) => {
				if (req.method() === "POST" && new URL(req.url()).pathname === "/fate") {
					bFateRequests += 1;
				}
			});

			const stamp = `${Date.now().toString(36)}${randomSuffix(3)}`;
			const title = `feed live ${stamp}`;
			await submitPost(pageA, title);

			await expect(
				pageB.locator(".kp-pano-list").getByText(title, {exact: false}).first(),
			).toBeVisible({timeout: 15_000});
			// No `/fate` data request fired on B between the settle and the row
			// appearing → the post arrived purely over the live SSE stream.
			expect(bFateRequests).toBe(0);
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
