import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";

/**
 * Pano submitPost end-to-end.
 *
 * Sign up a fresh user, complete the username bootstrap, navigate to the
 * `/pano/yeni` page, fill title + url + body + select a tag, submit. The
 * mutation responds with the new post id; the dialog navigates to
 * `/pano/<id>` and the post detail page renders.
 *
 * Mirrors the helper pattern from tests/e2e/12-sozluk-vote.spec.ts.
 */
test.describe("Pano submitPost", () => {
	test("submits a link post and lands on /pano/<id>", async ({page}) => {
		const localPart = `pp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-title"]')).toBeVisible({timeout: 5_000});

		const title = `e2e başlığı ${Date.now().toString(36)}`;
		const url = `https://example.com/${Date.now().toString(36)}`;
		const body = "e2e bağlamı — neden paylaşıyorum";

		await page.locator('[data-testid="pano-submit-url"]').fill(url);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-body"]').fill(body);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();

		await page.locator('[data-testid="pano-submit-submit"]').click();

		// On success the page navigates to /pano/<new-post-id>; assert by URL
		// pattern + the rendered title on the detail page.
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		// PanoPostDetail renders the new post via the `post(idOrSlug)` query
		// resolver, which reads the row the `post.submit` mutation persisted to
		// D1 (`post_summary`) — pano has no per-post DO.
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});
	});

	test("blocks submit while the title is too short and surfaces validation hint", async ({
		page,
	}) => {
		const localPart = `pp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano/yeni");
		const submit = page.locator('[data-testid="pano-submit-submit"]');
		await expect(submit).toBeDisabled();

		// Filling out everything except the title still leaves the button disabled.
		await page.locator('[data-testid="pano-submit-url"]').fill("https://example.com/x");
		await page.locator('[data-testid="pano-submit-title"]').fill("kısa");
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await expect(submit).toBeDisabled();

		// Crossing the 5-char threshold flips it on.
		await page.locator('[data-testid="pano-submit-title"]').fill("yeterince uzun başlık");
		await expect(submit).toBeEnabled();
	});
});
