import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {promoteToYazar} from "./_helpers/promote";
import {randomSuffix} from "./_helpers/rand";

/**
 * The landing stats card, whose counters the sozluk/pano writer modules maintain
 * inline on every write (ADR 0009), plus a deep-link smoke check of the canonical
 * product URLs.
 */
test.describe("Landing stats", () => {
	test("/ renders the live stats card with five values", async ({page}) => {
		await page.goto("/");

		await expect(page.getByTestId("kp-landing-stats")).toBeVisible({timeout: 10_000});
		const stats = page.locator(".kp-landing__stats .kp-landing__stat");
		await expect(stats).toHaveCount(5);

		const versionLabel = page.locator(".kp-landing__stats .kp-landing__stat .l", {
			hasText: /^phoenix$/,
		});
		await expect(versionLabel).toBeVisible();
	});

	test("submitting a post bumps totalPosts on /", async ({page}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;
		const email = `ls${suffix}@kamp.us`;
		await signUp(page, {email});
		const handle = `ls-${suffix}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});
		// `totalPosts` is the PUBLIC live count (`makePersistPanoStats` folds it behind
		// the anonymous viewer's `publicLivePostWhere`), so a çaylak's sandboxed first
		// post correctly moves nothing. This spec is about the counter, not the sandbox:
		// promote the author so the submit below is publicly live and the count can rise
		// (ADR 0137). Sandbox coverage lives in the kunye/sandbox suites, untouched.
		await promoteToYazar(email);

		await page.goto("/");
		await expect(page.getByTestId("kp-landing-stats")).toBeVisible({timeout: 10_000});
		const before = await page.getByTestId("stat-başlık").locator(".n").innerText();
		const beforeCount = parseTrNumber(before);

		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});
		await page
			.locator('[data-testid="pano-submit-url"]')
			.fill(`https://example.com/landing-${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(`landing stats başlık ${suffix}`);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		// The reload is intentional: a bare `goto("/")` may serve a cached
		// landingStats result; reloading forces a fresh fetch.
		await page.goto("/");
		await page.reload();
		await expect(page.getByTestId("kp-landing-stats")).toBeVisible({timeout: 10_000});
		await expect(async () => {
			const text = await page.getByTestId("stat-başlık").locator(".n").innerText();
			expect(parseTrNumber(text)).toBeGreaterThan(beforeCount);
		}).toPass({timeout: 15_000});
	});

	test("canonical routes are deep-linkable", async ({page}) => {
		await page.goto("/sozluk");
		await expect(page.locator(".kp-page")).toBeVisible({timeout: 10_000});

		await page.goto("/pano");
		// Assert the topbar, not the feed — the feed may be empty on a cold DB.
		await expect(page.locator(".kp-topbar")).toBeVisible({timeout: 10_000});

		await page.goto("/auth");
		await expect(page.getByRole("heading", {name: /giriş yap/i})).toBeVisible({timeout: 10_000});

		await page.goto(`/u/nobody-${Date.now().toString(36)}`);
		await expect(page.getByTestId("not-found-page")).toBeVisible({timeout: 10_000});
	});
});

function parseTrNumber(s: string): number {
	// Turkish locale uses '.' as a thousands separator. Strip them.
	return Number(s.replace(/\./g, "").trim()) || 0;
}
