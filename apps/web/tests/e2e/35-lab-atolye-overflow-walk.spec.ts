import {expect, type Page, type TestInfo, test} from "@playwright/test";
import {gotoSpaReady, SPA_READY_DEADLINE_MS} from "./_helpers/spa-ready";

/**
 * The horizontal-overflow walk (ADR 0460, #10456): every exhibit the atölye registry lists is
 * opened at its own address at a phone and a desktop width, and the page's document must be no
 * wider than its viewport. The exhibit ids are read off the registry-driven index page, so a newly
 * registered exhibit is walked with no edit here.
 */

const VIEWPORT_WIDTHS = [390, 1280] as const;
const VIEWPORT_HEIGHT = 844;
const PER_EXHIBIT_BUDGET_MS = 8_000;

interface WidestOverflow {
	readonly selector: string;
	readonly width: number;
	readonly right: number;
}

interface PageWidth {
	readonly scrollWidth: number;
	readonly clientWidth: number;
}

async function readExhibitIds(page: Page): Promise<readonly string[]> {
	await gotoSpaReady(page, "/lab/atolye");
	await expect(page.getByTestId("lab-atolye-index")).toBeVisible();
	const hrefs = await page
		.locator(".kp-atolye__item a")
		.evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
	return hrefs.map((href) => {
		const match = /^\/lab\/atolye\/([^/?#]+)$/.exec(href);
		if (!match?.[1]) throw new Error(`atölye index card links to an unexpected address: "${href}"`);
		return match[1];
	});
}

async function openExhibit(page: Page, id: string): Promise<void> {
	await gotoSpaReady(page, `/lab/atolye/${id}`);
	await expect(
		page.getByTestId("lab-atolye-detail"),
		`${id} did not reach its detail view`,
	).toBeVisible();
	await expect(page.getByTestId("exhibit-stage"), `${id} rendered no exhibit stage`).toBeVisible();
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

function readPageWidth(page: Page): Promise<PageWidth> {
	return page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
}

// Only elements no ancestor clips on the x axis can push the page; one inside a scroll region or an
// `overflow: hidden` box is contained, so it is not the cause.
function findWidestOverflow(page: Page): Promise<WidestOverflow | null> {
	return page.evaluate(() => {
		const viewport = document.documentElement.clientWidth;
		const clipsX = (element: Element) => getComputedStyle(element).overflowX !== "visible";
		const isContained = (element: Element) => {
			for (
				let parent = element.parentElement;
				parent && parent !== document.body;
				parent = parent.parentElement
			) {
				if (clipsX(parent)) return true;
			}
			return false;
		};
		const describe = (element: Element) => {
			const testId = element.getAttribute("data-testid");
			const classes = [...element.classList].map((name) => `.${name}`).join("");
			return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${classes}${testId ? `[data-testid="${testId}"]` : ""}`;
		};
		let widest: {selector: string; width: number; right: number} | null = null;
		for (const element of document.body.querySelectorAll("*")) {
			const rect = element.getBoundingClientRect();
			if (rect.right <= viewport || isContained(element)) continue;
			if (!widest || rect.width > widest.width) {
				widest = {
					selector: describe(element),
					width: Math.round(rect.width),
					right: Math.round(rect.right),
				};
			}
		}
		return widest;
	});
}

async function attachOverflowEvidence(
	page: Page,
	testInfo: TestInfo,
	label: string,
	measured: PageWidth,
): Promise<void> {
	const widest = await findWidestOverflow(page);
	await testInfo.attach(`${label}.png`, {
		body: await page.screenshot({fullPage: true}),
		contentType: "image/png",
	});
	await testInfo.attach(`${label}.json`, {
		body: JSON.stringify({...measured, widestOverflowingElement: widest}, null, 2),
		contentType: "application/json",
	});
}

for (const width of VIEWPORT_WIDTHS) {
	test(`atölye overflow walk: no exhibit is wider than a ${width}px viewport`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({width, height: VIEWPORT_HEIGHT});
		const ids = await readExhibitIds(page);
		expect(ids.length, "the atölye index listed no exhibits").toBeGreaterThan(0);
		test.setTimeout(SPA_READY_DEADLINE_MS + ids.length * PER_EXHIBIT_BUDGET_MS);

		for (const id of ids) {
			await openExhibit(page, id);
			const measured = await readPageWidth(page);
			if (measured.scrollWidth > measured.clientWidth) {
				await attachOverflowEvidence(page, testInfo, `${id}-${width}px`, measured);
			}
			expect
				.soft(measured.scrollWidth, `${id} at ${width}px: scrollWidth exceeds clientWidth`)
				.toBeLessThanOrEqual(measured.clientWidth);
		}
	});
}
