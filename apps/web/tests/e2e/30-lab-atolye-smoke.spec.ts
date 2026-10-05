import {expect, test} from "@playwright/test";
import {gotoSpaReady, SPA_READY_DEADLINE_MS} from "./_helpers/spa-ready";

/**
 * atölye smoke journey (#3096, capstone of epic #2473) — the reachability guarantee for the
 * public `/lab/atolye` harness. One representative journey: load the registry-driven index, open a
 * known exhibit's detail route, twiddle a knob, and confirm the render updates AND the knob state
 * round-trips through the URL (#3093). atölye ships as a plain public route (not behind a Flagship
 * flag), so ADR-0173 flag-keyed reachability doesn't apply — this e2e is the `/lab`-convention
 * equivalent, keeping the harness reachable and unbroken as exhibits evolve.
 *
 * The Button exhibit (`button`) is the fixed anchor: it's the harness's worked exemplar, first in
 * the registry, with a `variant` enum knob whose value lands on `data-variant` on the rendered
 * button — a directly observable render change and a serializable URL param in one.
 */

test("atölye smoke journey: index lists exhibits → open exhibit → change knob updates render", async ({
	page,
}) => {
	test.setTimeout(SPA_READY_DEADLINE_MS + 15_000);

	await gotoSpaReady(page, "/lab/atolye");
	await expect(page.getByTestId("lab-atolye-index")).toBeVisible();
	const cards = page.locator(".kp-atolye__item");
	expect(await cards.count()).toBeGreaterThan(1);
	const buttonCard = page.locator('a[href="/lab/atolye/button"]');
	await expect(buttonCard).toBeVisible();

	await buttonCard.click();
	await expect(page).toHaveURL(/\/lab\/atolye\/button$/);
	await expect(page.getByTestId("lab-atolye-detail")).toBeVisible();
	const stagedButton = page.locator('[data-testid="exhibit-stage"] .kp-btn');
	await expect(stagedButton).toBeVisible();
	await expect(stagedButton).toHaveAttribute("data-variant", "primary");

	await page.locator('[data-knob="variant"]').getByRole("radio", {name: "Secondary"}).click();
	await expect(stagedButton).toHaveAttribute("data-variant", "secondary");
	await expect(page).toHaveURL(/[?&]variant=secondary(&|$)/);
});

test("atölye knob state round-trips through the URL (deep-link ↔ live twiddle)", async ({page}) => {
	test.setTimeout(SPA_READY_DEADLINE_MS + 15_000);

	await gotoSpaReady(page, "/lab/atolye/button?variant=danger");
	const stagedButton = page.locator('[data-testid="exhibit-stage"] .kp-btn');
	await expect(stagedButton).toBeVisible();
	await expect(stagedButton).toHaveAttribute("data-variant", "danger");

	// Toggling back to the schema default drops the param: a pristine exhibit's URL is param-free.
	await page.locator('[data-knob="variant"]').getByRole("radio", {name: "Primary"}).click();
	await expect(stagedButton).toHaveAttribute("data-variant", "primary");
	await expect(page).not.toHaveURL(/[?&]variant=/);
});
