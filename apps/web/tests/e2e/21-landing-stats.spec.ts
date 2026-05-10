import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Landing stats (T15) — `landingStats` GraphQL query feeding the landing-page
 * stats card. Live counters maintained by the `PhoenixProjection` workflow
 * after every Definition / Post / Comment event. The page also serves as a
 * deep-link smoke check: directly visiting the canonical product URLs should
 * each render without errors.
 */
test.describe("Landing stats (task_15)", () => {
	test("/ renders the live stats card with five values", async ({page}) => {
		await page.goto("/");

		// QueryBoundary suspense fallback first; the live stats land within a
		// few hundred ms once the worker responds.
		await expect(page.getByTestId("kp-landing-stats")).toBeVisible({timeout: 10_000});
		const stats = page.locator(".kp-landing__stats .kp-landing__stat");
		await expect(stats).toHaveCount(5);

		// Last cell is the build version label "phoenix" with a non-empty value.
		const versionLabel = page.locator(".kp-landing__stats .kp-landing__stat .l", {
			hasText: /^phoenix$/,
		});
		await expect(versionLabel).toBeVisible();
	});

	test("submitting a post bumps totalPosts on /", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `ls${suffix}@kamp.us`});
		const handle = `ls-${suffix}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		// Capture totalPosts BEFORE we submit.
		await page.goto("/");
		await expect(page.getByTestId("kp-landing-stats")).toBeVisible({timeout: 10_000});
		const before = await page.getByTestId("stat-başlık").locator(".n").innerText();
		const beforeCount = parseTrNumber(before);

		// Submit a post.
		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});
		await page
			.locator('[data-testid="pano-submit-url"]')
			.fill(`https://example.com/landing-${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(`landing stats başlık ${suffix}`);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		// Reload landing — the stats card should now reflect the new post.
		await page.goto("/");
		await page.reload();
		await expect(page.getByTestId("kp-landing-stats")).toBeVisible({timeout: 10_000});
		await expect(async () => {
			const text = await page.getByTestId("stat-başlık").locator(".n").innerText();
			expect(parseTrNumber(text)).toBeGreaterThan(beforeCount);
		}).toPass({timeout: 15_000});
	});

	test("canonical routes are deep-linkable", async ({page}) => {
		// `/sozluk`
		await page.goto("/sozluk");
		await expect(page.locator(".kp-page")).toBeVisible({timeout: 10_000});

		// `/pano`
		await page.goto("/pano");
		// PanoFeed renders inside the same shell. Just ensure the topbar is
		// up; the feed itself may be empty on a cold DB.
		await expect(page.locator(".kp-topbar")).toBeVisible({timeout: 10_000});

		// `/auth`
		await page.goto("/auth");
		await expect(page.getByRole("heading", {name: /giriş yap/i})).toBeVisible({timeout: 10_000});

		// `/u/<unknown>` falls through to the 404 page.
		await page.goto(`/u/nobody-${Date.now().toString(36)}`);
		await expect(page.getByTestId("not-found-page")).toBeVisible({timeout: 10_000});
	});
});

function parseTrNumber(s: string): number {
	// Turkish locale uses '.' as a thousands separator. Strip them.
	return Number(s.replace(/\./g, "").trim()) || 0;
}
