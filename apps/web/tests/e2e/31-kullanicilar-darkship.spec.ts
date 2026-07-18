import {expect, test} from "@playwright/test";

/**
 * Kullanıcılar (user-roster) read-view dark-ship invariant — the off-path proven in-browser
 * (#3200).
 *
 * The `phoenix-user-admin` flag (and the `phoenix-admin-console` shell flag) default OFF in
 * the local/CI env, so the roster ships dark: the `/admin` route resolves to the ordinary
 * not-found page (the console shell never mounts) and no `kullanicilar-*` element renders
 * anywhere. This is the dark-ship invariant (ADR 0083) — it does NOT depend on a signed-in
 * admin session, so it's stable to run on the default-off flag.
 *
 * The on-path (an admin opens the roster → the gated `userAdmin.list` returns rows → the
 * table renders) needs release plumbing (both flags on + a discharged `Admin` grant), so it
 * is covered by the unit tests (`worker/features/user-admin/lists.unit.test.ts` proves the
 * requireAdmin gate + shaping; the module + panel-logic tests prove the SPA wiring) — the
 * same off-path/on-path split as `28-reaction-bar-darkship.spec.ts`.
 */
// @journey:phoenix-user-admin — the registered reachability journey for the user-admin
// vertical (ADR 0173 §2). reachability-guard asserts this tag exists; the e2e job runs it.
test.describe("Kullanıcılar roster (dark-ship, phoenix-user-admin default off) @journey:phoenix-user-admin", () => {
	test("the /admin console route is inert and no roster leaks while the flag defaults off", async ({
		page,
	}) => {
		await page.goto("/admin");
		// The admin console shell never mounts (its own flag is off too)…
		await expect(page.locator('[data-testid="admin-console"]')).toHaveCount(0);
		// …and the kullanıcılar panel / roster is definitively absent.
		await expect(page.locator('[data-testid="kullanicilar-panel"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="kullanicilar-table"]')).toHaveCount(0);
	});

	test("no kullanıcılar roster renders on a public page while the flag defaults off", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.locator("body")).toBeVisible();
		await expect(page.locator('[data-testid="kullanicilar-panel"]')).toHaveCount(0);
	});
});
