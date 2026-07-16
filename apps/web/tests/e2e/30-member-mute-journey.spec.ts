import {expect, type Page, test} from "@playwright/test";
import {completeBootstrap, signUp} from "./_helpers/auth";

/**
 * The reachability journey for the member-mute (sustur) vertical (ADR 0173 §2, epic #2035).
 * `reachability-guard` asserts the `@journey:member-mute` tag exists; the e2e job runs the spec.
 *
 * The member-mute containment flag defaults OFF and — unlike the integration stage — the e2e
 * preview deploys with `ENVIRONMENT=preview`, where the `phoenix_flag_overrides` cookie is
 * dropped (FlagsContext), so the server on-path cannot be flipped per request from a test. So
 * the split mirrors `28-reaction-bar-darkship` / `29-edge-shell-boot-journey`: the pure client
 * logic is unit-tested (`src/components/mute/muteStore.unit.test.ts`), the DARK-SHIP off-path is
 * proven against the real preview (flag off ⇒ no mute surface, route self-404), and the ON-path
 * UX is reproduced deterministically by seeding the flag client-side (intercepting
 * `/api/flags/evaluate`) and stubbing the mute fate operations (`/fate`), driving the real feed
 * through the full mute → hidden → manage → unmute → returns loop.
 */

// The member-mute fate view types the mute ops return over the wire (server.mjs envelope:
// `{version:1, results:[{id, ok, data}]}`; the connection shape is `{items:[{cursor,node}],
// pagination}` per worker `toConnection`). Kept as a plain shape here — the worker owns the type.
type StubbedMute = {id: string; username: string | null; displayName: string | null};

/** Force `member-mute` on for the CLIENT `useFlag` fetch path (non-boot member ⇒ POST evaluate). */
async function seedMemberMuteFlagOn(page: Page): Promise<void> {
	await page.route("**/api/flags/evaluate", async (route) => {
		let body: {keys?: Array<{key?: unknown; default?: unknown}>} = {};
		try {
			body = JSON.parse(route.request().postData() ?? "{}");
		} catch {
			body = {};
		}
		const flags: Record<string, boolean> = {};
		for (const entry of body.keys ?? []) {
			if (entry && typeof entry.key === "string") {
				flags[entry.key] =
					entry.key === "member-mute"
						? true
						: typeof entry.default === "boolean"
							? entry.default
							: false;
			}
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({flags}),
		});
	});
}

/**
 * Stub ONLY the mute fate operations, passing every other `/fate` request (the real feed, the
 * bootstrap `setUsername`) through untouched. Stateful: `mute.set`/`mute.remove` drive the
 * `muted` map the `mute.listMine` stub then serves, so the manage screen reflects the mutes.
 */
async function stubMuteFate(page: Page, muted: Map<string, StubbedMute>): Promise<void> {
	await page.route("**/fate", async (route) => {
		const request = route.request();
		if (request.method() !== "POST") return route.continue();
		let body: {operations?: Array<Record<string, unknown>>} = {};
		try {
			body = JSON.parse(request.postData() ?? "{}");
		} catch {
			return route.continue();
		}
		const operations = Array.isArray(body.operations) ? body.operations : [];
		const isMuteOp = (op: Record<string, unknown>) =>
			typeof op.name === "string" && op.name.startsWith("mute.");
		if (operations.length === 0 || !operations.every(isMuteOp)) return route.continue();

		const results = operations.map((op) => {
			const name = op.name as string;
			const input = (op.input as {mutedId?: string}) ?? {};
			if (name === "mute.set") {
				const id = input.mutedId ?? "";
				if (!muted.has(id)) muted.set(id, {id, username: null, displayName: null});
				return {
					id: op.id,
					ok: true,
					data: {__typename: "MuteReceipt", id, isMuted: true, changed: true},
				};
			}
			if (name === "mute.remove") {
				const id = input.mutedId ?? "";
				muted.delete(id);
				return {
					id: op.id,
					ok: true,
					data: {__typename: "MuteReceipt", id, isMuted: false, changed: true},
				};
			}
			// mute.listMine — the viewer's persisted mutes, newest-first, as a fate connection.
			return {
				id: op.id,
				ok: true,
				data: {
					items: [...muted.values()].map((m) => ({
						cursor: `c-${m.id}`,
						node: {
							__typename: "MutedMember",
							id: m.id,
							username: m.username,
							displayName: m.displayName,
							mutedAt: new Date().toISOString(),
						},
					})),
					pagination: {hasNext: false, hasPrevious: false},
				},
			};
		});

		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({version: 1, results}),
		});
	});
}

test.describe("member mute (sustur) @journey:member-mute", () => {
	test("dark-ship: flag off ⇒ no mute affordance on the feed and /susturduklarim self-404s", async ({
		page,
	}) => {
		// No interception — the real preview resolves `member-mute` to its safe default (off).
		await page.goto("/pano");
		// The feed rendered…
		await expect(page.locator(".kp-pano-post").first()).toBeVisible({timeout: 10_000});
		// …and no flag-gated "sustur" action leaked onto any card.
		await expect(page.locator('[data-testid^="member-mute-"]')).toHaveCount(0);

		// The manage route is absent while the flag is off — it self-404s (the mecmua/bildirim idiom).
		await page.goto("/susturduklarim");
		await expect(page.locator('[data-testid="not-found-page"]')).toBeVisible({timeout: 10_000});
		await expect(page.locator('[data-testid="mutes-page"]')).toHaveCount(0);
	});

	test("on-path: mute a member → their post hides → manage → unmute → content returns", async ({
		page,
	}) => {
		const muted = new Map<string, StubbedMute>();
		await seedMemberMuteFlagOn(page);
		await stubMuteFate(page, muted);

		// A real signed-in session — muting is a signed-in act (CurrentUser is the muter).
		await signUp(page, {
			email: `mm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@kamp.us`,
		});
		await completeBootstrap(page);

		await page.goto("/pano");

		// The flag is seeded on ⇒ the "sustur" action renders on other members' feed cards. Pick
		// the first and derive the target member id from its testid (`member-mute-<memberId>`).
		const muteButton = page.locator('[data-testid^="member-mute-"]').first();
		await expect(muteButton).toBeVisible({timeout: 10_000});
		const testId = await muteButton.getAttribute("data-testid");
		const memberId = (testId ?? "").replace("member-mute-", "");
		expect(memberId.length).toBeGreaterThan(0);
		// Capture the member's shown handle so the manage row renders it (fed into the listMine stub).
		const authorLabel = (
			await muteButton
				.locator("xpath=ancestor::article")
				.locator(".author")
				.first()
				.innerText()
				.catch(() => "")
		).trim();

		// Mute → the mutation stub records the member; the card unmounts (the client overlay hides it).
		await muteButton.click();
		if (authorLabel) {
			const existing = muted.get(memberId);
			if (existing) existing.displayName = authorLabel;
		}
		await expect(page.locator(`[data-testid="member-mute-${memberId}"]`)).toHaveCount(0, {
			timeout: 10_000,
		});

		// Manage screen: the muted member is listed with a per-row unmute.
		await page.goto("/susturduklarim");
		await expect(page.locator('[data-testid="mutes-page"]')).toBeVisible({timeout: 10_000});
		const row = page.locator(`[data-testid="mute-row-${memberId}"]`);
		await expect(row).toBeVisible({timeout: 10_000});

		// Unmute → the mutation stub drops the member; the row is removed.
		await page.locator(`[data-testid="mute-unmute-${memberId}"]`).click();
		await expect(row).toHaveCount(0, {timeout: 10_000});
		expect(muted.has(memberId)).toBe(false);

		// Back on the feed the member's content is reachable again (their card + "sustur" return).
		await page.goto("/pano");
		await expect(page.locator(`[data-testid="member-mute-${memberId}"]`).first()).toBeVisible({
			timeout: 10_000,
		});
	});
});
