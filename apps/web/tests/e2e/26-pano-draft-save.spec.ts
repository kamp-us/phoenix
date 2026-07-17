import {expect, test} from "@playwright/test";
import {signUp} from "./_helpers/auth";
import {randomSuffix} from "./_helpers/rand";

/**
 * Pano taslak (draft-save) dark-ship invariant — the off-path proven in-browser.
 *
 * The `pano-draft-save` flag defaults OFF (IaC, #746), so the `FlagGate` around the
 * taslak button renders nothing: the new-post page is byte-identical to today and
 * the `pano-submit-draft` button is ABSENT. This is the dark-ship invariant — it
 * does NOT depend on fate-live, so it is stable to run on the default-off flag.
 *
 * The on-path (flag flipped → button appears → save persists a draft with
 * isDraft: true) is covered by the unit test
 * `worker/features/pano/draft-save.invariant.test.ts` (the flag-on path needs
 * release plumbing landing separately), so this e2e stays on the off-path.
 *
 * Mirrors the signUp + bootstrap + goto `/pano/yeni` pattern of
 * tests/e2e/14-pano-submit-post.spec.ts.
 */
test.describe("Pano draft-save (dark-ship, flag default off)", () => {
	test("the taslak draft button is absent while the flag defaults off", async ({page}) => {
		const localPart = `pd${Date.now().toString(36)}${randomSuffix(4)}`;
		await signUp(page, {email: `${localPart}@kamp.us`});
		const handle = `u-${Date.now().toString(36)}${randomSuffix(4)}`;
		await page.locator("input#bootstrap-username").fill(handle);
		await page.getByRole("button", {name: /devam et/i}).click();
		await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
			timeout: 10_000,
		});

		await page.goto("/pano/yeni");
		// The submit button proves the form rendered…
		await expect(page.locator('[data-testid="pano-submit-submit"]')).toBeVisible({
			timeout: 5_000,
		});
		// …and the flag-gated draft button is absent (FlagGate hides it when off).
		await expect(page.locator('[data-testid="pano-submit-draft"]')).toHaveCount(0);
	});
});
