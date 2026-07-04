import {expect, test} from "@playwright/test";

/**
 * Curated-palette reaction bar dark-ship invariant — the off-path proven
 * in-browser (#1867, epic #1840).
 *
 * The `phoenix-reactions` flag defaults OFF in the local/CI env, so the
 * `FlagGate` around the reaction bar renders nothing on every gated surface: the
 * pano feed post cards and the sözlük definition cards are byte-identical to today
 * and no `reaction-bar-*` element appears. This is the dark-ship invariant (ADR
 * 0083) — it does NOT depend on fate-live or a signed-in session, so it's stable
 * to run on the default-off flag.
 *
 * The on-path (flag on → palette + counts render → tap react/change/retract with
 * the optimistic-then-reconcile loop) is covered by the unit tests
 * `src/components/reaction/reactionModel.test.ts` +
 * `reactionDispatch.test.ts` (the flag-on path needs release plumbing / a
 * seeded reaction, landing at release), so this e2e stays on the off-path — the
 * same split as `26-pano-draft-save.spec.ts`.
 */
test.describe("Reaction bar (dark-ship, phoenix-reactions default off)", () => {
	test("no reaction bar renders on pano post cards while the flag defaults off", async ({page}) => {
		await page.goto("/pano");
		// The feed rendered (a post card is present)…
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
		// …and no flag-gated reaction bar leaked onto any card.
		await expect(page.locator('[data-testid^="reaction-bar-"]')).toHaveCount(0);
	});

	test("no reaction bar renders on sözlük definition cards while the flag defaults off", async ({
		page,
	}) => {
		await page.goto("/sozluk");
		const firstRow = page.locator(".kp-sozluk-term-row").first();
		await expect(firstRow).toBeVisible({timeout: 10_000});
		await firstRow.click();
		// A definition card rendered…
		await expect(page.locator(".kp-sozluk-definition").first()).toBeVisible({timeout: 10_000});
		// …and no flag-gated reaction bar leaked onto it.
		await expect(page.locator('[data-testid^="reaction-bar-"]')).toHaveCount(0);
	});
});
