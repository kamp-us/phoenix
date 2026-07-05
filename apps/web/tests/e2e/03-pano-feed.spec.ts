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

	test("filter chips toggle aria-pressed; switching writes ?sort= to the URL", async ({page}) => {
		// The active sort is URL-addressable (#2072): clicking a chip writes
		// `?sort=<server sort>` so the feed is deep-linkable, reload-stable, and
		// back/forward-navigable. Each chip's Turkish label maps to its English
		// server sort (see PANO_FILTERS in src/lib/panoNav.ts).
		const chips: {label: string; sort: string}[] = [
			{label: "sıcak", sort: "hot"},
			{label: "yeni", sort: "new"},
			{label: "en iyi", sort: "top"},
			{label: "tartışma", sort: "discuss"},
		];
		for (const {label, sort} of chips) {
			// QueryBoundary renders a chrome twice (loading + ok), so two subnav
			// instances briefly exist after navigation. Once the lazy query
			// resolves, only the .ok chrome stays mounted — but to dodge the
			// race, we always pick the *last* chip with each label.
			const chip = page.getByRole("button", {name: new RegExp(`^${label}$`, "i")}).last();
			await chip.click();
			await expect(chip).toHaveAttribute("aria-pressed", "true");
			await expect(page).toHaveURL(`/pano?sort=${sort}`);
		}
	});

	test("selected sort survives reload and back/forward navigation", async ({page}) => {
		const topChip = page.getByRole("button", {name: /^en iyi$/i}).last();
		await topChip.click();
		await expect(page).toHaveURL("/pano?sort=top");

		// Reload restores the sort from the URL, not the default.
		await page.reload();
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
		await expect(page).toHaveURL("/pano?sort=top");
		await expect(page.getByRole("button", {name: /^en iyi$/i}).last()).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		// A second switch pushes a history entry, so back returns to the prior sort.
		const newChip = page.getByRole("button", {name: /^yeni$/i}).last();
		await newChip.click();
		await expect(page).toHaveURL("/pano?sort=new");
		await page.goBack();
		await expect(page).toHaveURL("/pano?sort=top");
		await page.goForward();
		await expect(page).toHaveURL("/pano?sort=new");
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
		// Only a link-post renders an <a.kp-pano-post__site>; a self-post renders a
		// non-navigating <span> with the same class. Target the anchor so the
		// skip-guard skips on self-only feeds and the click hits a real link.
		const siteLink = page.locator("a.kp-pano-post__site").first();
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
