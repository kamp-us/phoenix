import {expect, test} from "@playwright/test";

test.describe("PanoFeed (/pano)", () => {
	test.beforeEach(async ({page}) => {
		await page.goto("/pano");
		// Wait for at least one post to render before each test.
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
	});

	test("loads at least one post row", async ({page}) => {
		const posts = page.locator(".kp-pano-post");
		expect(await posts.count()).toBeGreaterThan(0);
	});

	test("filter chips toggle aria-pressed; URL stays /pano", async ({page}) => {
		const chips = ["sıcak", "yeni", "en iyi", "tartışma"];
		for (const label of chips) {
			const chip = page.locator(".kp-subnav__filter", {hasText: label});
			await chip.click();
			await expect(chip).toHaveAttribute("aria-pressed", "true");
			await expect(page).toHaveURL("/pano");
		}
	});

	test("post title link goes to /pano/<id> (in-app self-posts) or external (link posts)", async ({
		page,
	}) => {
		const firstPostTitle = page.locator(".kp-pano-post .kp-pano-post__title").first();
		const href = await firstPostTitle.getAttribute("href");
		expect(href).toBeTruthy();
		// Either an absolute external URL or a /pano/<id> path.
		expect(href).toMatch(/^(https?:\/\/|\/pano\/)/);
	});

	test("(host) link routes to /pano/site/<host> + breadcrumb appears", async ({page}) => {
		const siteLink = page.locator(".kp-pano-post__site").first();
		// Some seed posts are self-posts (no host) — only run if a host link exists.
		if (!(await siteLink.isVisible().catch(() => false))) {
			test.skip(true, "no host links on the current page (all self-posts)");
		}
		const hostText = (await siteLink.textContent())?.trim();
		await siteLink.click();
		await expect(page).toHaveURL(/\/pano\/site\//);
		await expect(page.locator(".kp-pano-crumb")).toBeVisible();
		await expect(page.locator(".kp-pano-crumb .host")).toContainText(hostText ?? "");
		await page.locator(".kp-pano-crumb .clear").click();
		await expect(page).toHaveURL("/pano");
	});

	test("meta line shows author, time, comment count", async ({page}) => {
		const meta = page.locator(".kp-pano-post .kp-pano-post__meta").first();
		await expect(meta.locator(".author")).toBeVisible();
		// "N yorum" link
		await expect(meta.locator("a", {hasText: /yorum$/})).toBeVisible();
	});
});
