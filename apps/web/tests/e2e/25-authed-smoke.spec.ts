import {expect, test} from "@playwright/test";

/**
 * Authed-session smoke (ADR 0085). Runs in the `authed` project: the `setup`
 * project signs up ONCE and captures the session into storageState, so this test
 * starts already logged in. It proves the injected session is LIVE end-to-end —
 * the storageState → `setup` → `authed` path stays validated even though the
 * search specs (now public reads) moved to the `unauth` project.
 *
 * The authed-only affordances: the `.kp-topbar__user` pill in the global topbar, and
 * pano's `yeni gönderi` composer CTA in the pano Subnav's primary-action zone (placement
 * law #2587) — both rendered only when a session is present (a signed-out visitor sees
 * neither — see 02-topbar.spec.ts).
 */
test.describe("Authed session (storageState)", () => {
	test("the injected session renders authed-only affordances", async ({page}) => {
		await page.goto("/pano");

		await expect(page.locator(".kp-topbar__user")).toBeVisible({timeout: 10_000});
		await expect(page.getByRole("button", {name: /^yeni gönderi$/i})).toBeVisible();
	});
});
