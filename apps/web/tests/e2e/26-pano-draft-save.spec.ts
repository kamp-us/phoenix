import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

/**
 * Pano taslak (draft-save) — the live path proven in-browser.
 *
 * The taslak button used to sit behind a `FlagGate` on the draft-save dark-ship
 * flag (#746); that flag graduated and was retired (ADR 0136), so the button now
 * renders unconditionally on the new-post page. This spec does NOT depend on
 * fate-live, so it is stable to run standalone.
 *
 * Mirrors the signUp + bootstrap + goto `/pano/yeni` pattern of
 * tests/e2e/14-pano-submit-post.spec.ts.
 */
test.describe("Pano draft-save", () => {
	test("the taslak draft button renders on the new-post form", async ({page}) => {
		const localPart = `pd${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano/yeni");
		await expect(page.locator('[data-testid="pano-submit-submit"]')).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator('[data-testid="pano-submit-draft"]')).toBeVisible();
	});
});
