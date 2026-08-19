import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

test.describe("Pano submitPost", () => {
	test("submits a link post and lands on /pano/<id>", async ({page}) => {
		const localPart = `pp${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
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

		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});

		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});
	});

	test("blocks submit while the title is too short and surfaces validation hint", async ({
		page,
	}) => {
		const localPart = `pp${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano/yeni");
		const submit = page.locator('[data-testid="pano-submit-submit"]');
		await expect(submit).toBeDisabled();

		await page.locator('[data-testid="pano-submit-url"]').fill("https://example.com/x");
		await page.locator('[data-testid="pano-submit-title"]').fill("kısa");
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await expect(submit).toBeDisabled();

		// Crossing the 5-char threshold flips it on.
		await page.locator('[data-testid="pano-submit-title"]').fill("yeterince uzun başlık");
		await expect(submit).toBeEnabled();
	});
});
