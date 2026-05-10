import {type BrowserContext, expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Live updates over WebSocket via `useAgent` (task_16).
 *
 * Two browser contexts simulate two distinct users. User A mutates an entity
 * (votes on a definition, adds a comment); User B sits on the term/post page
 * and sees the change land without a manual refresh. The Agents SDK's
 * `setState` broadcasts to all connected clients; the page's `useLiveAgent`
 * hook bumps the Relay fetchKey on `lastEventId` change, which refetches
 * the GraphQL query and renders the new state.
 *
 * The Playwright multi-context pattern: `browser.newContext()` gives each
 * user a separate cookie jar so sign-ups don't share sessions.
 */

async function signUpAndBootstrap(context: BrowserContext) {
	const page = await context.newPage();
	const localPart = `live${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	await signUp(page, {email: `${localPart}@kamp.us`});

	// Username bootstrap: the topbar pill must end up with the chosen handle
	// before navigating away (the WS query reads the cookie-backed session).
	const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	await page.locator("input#bootstrap-username").fill(handle);
	await page.getByRole("button", {name: /devam et/i}).click();
	await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
		timeout: 10_000,
	});
	return {page, handle};
}

test.describe("Live updates via useAgent (task_16)", () => {
	test("definition added by user A appears in user B's term page without refresh", async ({
		browser,
	}) => {
		// Two cookie-isolated contexts → two distinct sessions.
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();

		try {
			const {page: pageA} = await signUpAndBootstrap(ctxA);
			const {page: pageB} = await signUpAndBootstrap(ctxB);

			// Fresh slug for this test run so it doesn't collide with seed data.
			const slug = `live-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

			// User A primes the term with a definition. The slug auto-creates the
			// SozlukTerm DO; without this seed the slug-not-yet-created branch
			// renders for user B and there's nothing to compare.
			await pageA.goto(`/sozluk/${slug}`);
			const composerA = pageA.locator('[data-testid="sozluk-composer-body"]');
			await expect(composerA).toBeVisible({timeout: 5_000});
			const firstDef = `seed definition ${Date.now()}`;
			await composerA.fill(firstDef);
			await pageA.locator('[data-testid="sozluk-composer-submit"]').click();
			await expect(pageA.getByText(firstDef)).toBeVisible({timeout: 10_000});

			// User B opens the same term URL. The WS subscription opens on mount.
			await pageB.goto(`/sozluk/${slug}`);
			await expect(pageB.getByText(firstDef)).toBeVisible({timeout: 10_000});

			// Wait for B's live pill to flip to connected so we know the WS is up
			// before triggering the mutation on A.
			await expect(pageB.getByTestId("live-pill-connected")).toBeVisible({timeout: 10_000});

			// User A adds a second definition. Scroll the composer into view —
			// after the first definition lands the page can be tall enough to
			// push the textarea below the fold.
			const secondDef = `live add ${Date.now()}`;
			await composerA.scrollIntoViewIfNeeded();
			await composerA.fill(secondDef);
			await pageA.locator('[data-testid="sozluk-composer-submit"]').click();
			await expect(pageA.getByText(secondDef)).toBeVisible({timeout: 10_000});

			// User B should see the new definition appear WITHOUT a manual reload.
			// The useLiveAgent → fetchKey refetch lands the new row from the
			// SozlukTerm DO.
			await expect(pageB.getByText(secondDef)).toBeVisible({timeout: 15_000});
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});

	test("comment added by user A appears in user B's post detail without refresh", async ({
		browser,
	}) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();

		try {
			const {page: pageA} = await signUpAndBootstrap(ctxA);
			const {page: pageB} = await signUpAndBootstrap(ctxB);

			// User A submits a fresh post via /pano/yeni so we have a clean
			// PanoPost DO to subscribe to. Use text mode so we don't have to
			// satisfy the URL-required validation on link mode.
			await pageA.goto("/pano/yeni");
			await expect(pageA.locator('[data-testid="pano-submit-title"]')).toBeVisible({
				timeout: 5_000,
			});
			await pageA.getByRole("button", {name: /^yazı$/i}).click();
			const title = `live post ${Date.now().toString(36)}`;
			await pageA.locator('[data-testid="pano-submit-title"]').fill(title);
			await pageA.locator('[data-testid="pano-submit-tag-discuss"]').click();
			await pageA.locator('[data-testid="pano-submit-submit"]').click();

			// Submit navigates to /pano/<id> — capture the id from the URL.
			// Exclude `/pano/yeni` from the match since the regex would otherwise
			// resolve before the navigation actually happens.
			await pageA.waitForURL(
				(url) => /\/pano\/[A-Za-z0-9_-]+$/.test(url.pathname) && !url.pathname.endsWith("/yeni"),
				{timeout: 15_000},
			);
			const postUrl = pageA.url();
			const postId = postUrl.split("/").pop()!;

			// User B opens the same post.
			await pageB.goto(`/pano/${postId}`);
			await expect(pageB.getByRole("heading", {name: title})).toBeVisible({timeout: 10_000});

			// Wait for B's WS to be open before mutating from A.
			await expect(pageB.getByTestId("live-pill-connected")).toBeVisible({timeout: 10_000});

			// User A posts a top-level comment.
			const commentText = `live comment ${Date.now()}`;
			const composerA = pageA.locator('[data-testid="pano-comment-input"]');
			await expect(composerA).toBeVisible({timeout: 5_000});
			await composerA.fill(commentText);
			await pageA.locator('[data-testid="pano-comment-submit"]').click();
			await expect(pageA.getByText(commentText)).toBeVisible({timeout: 10_000});

			// User B sees it appear without any user action.
			await expect(pageB.getByText(commentText)).toBeVisible({timeout: 15_000});
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
