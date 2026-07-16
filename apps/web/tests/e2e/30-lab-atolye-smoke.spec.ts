import {expect, type Page, test} from "@playwright/test";
import {isCloudflarePlaceholder404} from "../integration/_edge-ready";

/**
 * atölye smoke journey (#3096, capstone of epic #2473) — the reachability guarantee for the
 * public `/lab/atolye` harness. One representative journey: load the registry-driven index, open a
 * known exhibit's detail route, twiddle a knob, and confirm the render updates AND the knob state
 * round-trips through the URL (#3093). atölye ships as a plain public route (not behind a Flagship
 * flag), so ADR-0173 flag-keyed reachability doesn't apply — this e2e is the `/lab`-convention
 * equivalent, keeping the harness reachable and unbroken as exhibits evolve.
 *
 * Route/slug are ASCII English (`/lab/atolye`) per the routes-are-English convention + founder
 * ruling; the visible brand copy is Turkish (`atölye`, exhibit titles like `Düğme`).
 *
 * The Button exhibit (`button`) is the fixed anchor: it's the harness's worked exemplar, first in
 * the registry, with a `variant` enum knob whose value paints `kp-btn--<variant>` on the rendered
 * button — a directly observable render change and a serializable URL param in one.
 */

// Public route served by the SPA fallback: a fresh Playwright context's first paint can hit a cold
// Cloudflare edge PoP the preview-ready warm gate never touched, which serves the typed
// placeholder-404 (ADR 0127). Poll THROUGH that bounded window; a structured worker 404 or any
// other response returns at once for the caller's assertion to judge — same shape as 00-smoke.
const SPA_READY_DEADLINE_MS = 30_000;
const SPA_READY_POLL_MS = 1_500;

async function gotoSpaReady(page: Page, route: string): Promise<void> {
	const deadline = Date.now() + SPA_READY_DEADLINE_MS;
	while (Date.now() < deadline) {
		const res = await page.goto(route);
		if (!res || res.status() !== 404) return;
		if (!isCloudflarePlaceholder404(res.status(), await res.text())) return;
		await page.waitForTimeout(SPA_READY_POLL_MS);
	}
}

test("atölye smoke journey: index lists exhibits → open exhibit → change knob updates render", async ({
	page,
}) => {
	test.setTimeout(SPA_READY_DEADLINE_MS + 15_000);

	// 1. The index renders and lists exhibits — registry-driven, not a hardcoded route menu.
	await gotoSpaReady(page, "/lab/atolye");
	await expect(page.getByTestId("lab-atolye-index")).toBeVisible();
	const cards = page.locator(".kp-atolye__item");
	expect(await cards.count()).toBeGreaterThan(1);
	const buttonCard = page.locator('a[href="/lab/atolye/button"]');
	await expect(buttonCard).toBeVisible();

	// 2. Opening an exhibit deep-links to its detail route and mounts the ExhibitStage.
	await buttonCard.click();
	await expect(page).toHaveURL(/\/lab\/atolye\/button$/);
	await expect(page.getByTestId("lab-atolye-detail")).toBeVisible();
	const stagedButton = page.locator('[data-testid="exhibit-stage"] .kp-btn');
	await expect(stagedButton).toBeVisible();
	// Default variant knob → primary.
	await expect(stagedButton).toHaveClass(/kp-btn--primary/);

	// 3. Changing the `variant` enum knob re-renders the component AND reflects into the URL.
	await page.locator('[data-knob="variant"]').getByRole("button", {name: "İkincil"}).click();
	await expect(stagedButton).toHaveClass(/kp-btn--secondary/);
	await expect(page).toHaveURL(/[?&]variant=secondary(&|$)/);
});

test("atölye knob state round-trips through the URL (deep-link ↔ live twiddle)", async ({page}) => {
	test.setTimeout(SPA_READY_DEADLINE_MS + 15_000);

	// URL → state: landing a knob param restores that exhibit state (a shareable deep-link).
	await gotoSpaReady(page, "/lab/atolye/button?variant=danger");
	const stagedButton = page.locator('[data-testid="exhibit-stage"] .kp-btn');
	await expect(stagedButton).toBeVisible();
	await expect(stagedButton).toHaveClass(/kp-btn--danger/);

	// state → URL: toggling back to the schema default drops the param (a pristine exhibit's URL is
	// param-free), closing the round-trip in both directions.
	await page.locator('[data-knob="variant"]').getByRole("button", {name: "Birincil"}).click();
	await expect(stagedButton).toHaveClass(/kp-btn--primary/);
	await expect(page).not.toHaveURL(/[?&]variant=/);
});
