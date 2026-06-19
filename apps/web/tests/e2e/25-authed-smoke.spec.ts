import {expect, test} from "@playwright/test";

/**
 * Authed-session smoke (ADR 0085). Runs in the `authed` project: the `setup`
 * project signs up ONCE and captures the session into storageState, so this test
 * starts already logged in. It proves the injected session is LIVE end-to-end —
 * the storageState → `setup` → `authed` path stays validated even though the
 * search specs (now public reads) moved to the `unauth` project.
 *
 * The authed-only affordances: the `+ gönderi` composer button and the
 * `.kp-topbar__user` pill, both rendered only when a session is present (the
 * signed-out topbar shows neither — see 02-topbar.spec.ts).
 */
test.describe("Authed session (storageState)", () => {
	test("the injected session renders authed-only topbar affordances", async ({page}) => {
		await page.goto("/");

		await expect(page.locator(".kp-topbar__user")).toBeVisible({timeout: 10_000});
		await expect(page.getByRole("button", {name: /\+ gönderi/i})).toBeVisible();
	});
});
