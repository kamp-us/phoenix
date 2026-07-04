import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * T17 auth-redirect E2E: signed-out vote on a definition routes to
 * `/auth?returnTo=<term-url>`; after sign-up the user lands back on the
 * term page and the vote click now succeeds (score becomes 1).
 *
 * We seed the term by signing up a first user, adding a definition, then
 * signing them out — that leaves a real definition with a real id we can
 * vote on as the second (still-signed-out) user.
 */
test.describe("T17 auth-redirect with returnTo", () => {
	test("signed-out vote → /auth?returnTo=... → sign-up → return → vote succeeds", async ({
		page,
	}) => {
		// --- seed: sign up author A, drop a definition, sign out -------------
		const slug = `t17-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `author-${slug}@kamp.us`});
		const handleA = `a-${slug}`;
		await page.locator("input#bootstrap-username").fill(handleA);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto(`/sozluk/${slug}`);
		const composerBody = page.locator('[data-testid="sozluk-composer-body"]');
		await expect(composerBody).toBeVisible({timeout: 5_000});
		const body = `t17 vote target ${Date.now()}`;
		await composerBody.fill(body);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();
		await expect(page.getByText(body)).toBeVisible({timeout: 10_000});

		// Sign A out via the topbar user pill.
		const pill = page.locator(".kp-topbar__user").first();
		await pill.click();
		await page.getByRole("menuitem", {name: /çıkış/i}).click();
		await expect(page.locator(".kp-topbar__user")).toHaveCount(0, {timeout: 5_000});

		// --- act: signed-out user navigates to the term + clicks vote --------
		await page.goto(`/sozluk/${slug}`);
		const voteBtn = page.locator('[data-testid^="definition-vote-"]').first();
		await expect(voteBtn).toBeVisible({timeout: 5_000});
		await voteBtn.click();

		// Lands on /auth with `returnTo` = the term URL.
		await page.waitForURL(/\/auth\?returnTo=/, {timeout: 5_000});
		const url = new URL(page.url());
		const returnTo = url.searchParams.get("returnTo");
		expect(returnTo).toBe(`/sozluk/${slug}`);

		// --- sign up user B from the same /auth page (returnTo is preserved
		//     through the form submission because the URL doesn't change). --
		await page.getByRole("button", {name: /^kayıt ol$/i}).click();
		const emailB = `voter-${slug}@kamp.us`;
		await page.getByLabel("görünen ad").fill("voter b");
		await page.getByLabel("e-posta").fill(emailB);
		await page.getByLabel("parola").fill("hunter222!");
		await page.getByRole("button", {name: /hesap aç/i}).click();

		// Layout's effect navigates off /auth honoring `returnTo` (T17).
		await page.waitForURL(`**/sozluk/${slug}`, {timeout: 10_000});

		// Bootstrap form WILL render — voter B has just signed up with no username.
		// `me` lands a tick after the route navigation, so wait unconditionally.
		const bootstrap = page.locator("input#bootstrap-username");
		await expect(bootstrap).toBeVisible({timeout: 10_000});
		await bootstrap.fill(`b-${slug}`);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// --- assert: vote click now lands the +1 ------------------------------
		// Wait for the term heading first — the page may briefly render the
		// Suspense fallback while the term query lands after the redirect.
		await expect(page.getByRole("heading", {level: 1})).toContainText(slug.replace(/-/g, " "), {
			timeout: 10_000,
		});
		const score = page.locator('[data-testid^="definition-score-"]').first();
		const voteBtnAfter = page.locator('[data-testid^="definition-vote-"]').first();
		await expect(voteBtnAfter).toBeVisible({timeout: 10_000});
		await expect(score).toHaveText("0", {timeout: 10_000});

		await voteBtnAfter.click();
		await expect(score).toHaveText("1", {timeout: 5_000});
		await expect(voteBtnAfter).toHaveAttribute("aria-pressed", "true", {timeout: 5_000});
	});

	test("404 page renders for an unknown profile", async ({page}) => {
		// Smoke check — the NotFoundPage stays wired through the auth-redirect flow.
		await page.goto(`/u/nobody-${Date.now().toString(36)}`);
		await expect(page.getByTestId("not-found-page")).toBeVisible({timeout: 5_000});
		await expect(page.getByRole("heading", {name: /bulunamadı/i})).toBeVisible();
		// Three nav links.
		await expect(page.locator('.kp-not-found__links a[href="/"]')).toBeVisible();
		await expect(page.locator('.kp-not-found__links a[href="/sozluk"]')).toBeVisible();
		await expect(page.locator('.kp-not-found__links a[href="/pano"]')).toBeVisible();
	});

	test("catch-all 404 renders for an unknown route", async ({page}) => {
		await page.goto(`/this-route-does-not-exist-${Date.now().toString(36)}`);
		await expect(page.getByTestId("not-found-page")).toBeVisible({timeout: 5_000});
	});
});
