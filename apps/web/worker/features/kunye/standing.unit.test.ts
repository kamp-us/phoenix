/**
 * The pure promotion-bar rule (#1316) — `promotionBarFor` decides WHICH karma bar a
 * çaylak faces from a single fact: do they hold an active vouch. Kept pure (no
 * service, no Effect) so the "which bar applies" rule the çaylak-self standing read
 * exposes is testable in isolation (ADR 0082 unit tier) — the frontend never
 * hardcodes a bar because the live bar depends on vouch-exists.
 */
import {describe, it} from "@effect/vitest";
import {assert} from "vitest";
import {
	KARMA_THRESHOLDS,
	promotionBarFor,
	sandboxesNewContent,
	VOUCH_PROMOTION_KARMA_BAR,
} from "./standing.ts";

describe("promotionBarFor", () => {
	it("a vouched çaylak clears the reduced tandem bar", () => {
		assert.strictEqual(promotionBarFor(true), VOUCH_PROMOTION_KARMA_BAR);
	});

	it("an unvouched çaylak faces the full unassisted yazar threshold", () => {
		assert.strictEqual(promotionBarFor(false), KARMA_THRESHOLDS.yazar);
	});

	it("the vouch-assisted bar is strictly lower than the unassisted one", () => {
		assert.isBelow(promotionBarFor(true), promotionBarFor(false));
	});
});

/**
 * The create-time sandbox rule, shared by BOTH sides of a write (#4282): the server's
 * `sandboxedAtForAuthor` and the client's optimistic comment node. They must agree —
 * a client that guesses differently renders a çaylak's comment as published for the
 * whole optimistic window, which is exactly the false-publish being closed.
 */
describe("sandboxesNewContent", () => {
	it("a çaylak's new content lands sandboxed", () => {
		assert.strictEqual(sandboxesNewContent("çaylak"), true);
	});

	it("a yazar's new content is live", () => {
		assert.strictEqual(sandboxesNewContent("yazar"), false);
	});

	// A visitor authors nothing, and an unresolved tier (the `me` read still settling on
	// the client) must not guess `true` — an unwarranted `incelemede` on a yazar's comment
	// is as dishonest as the missing one on a çaylak's.
	it("a visitor and an unresolved tier both read false", () => {
		assert.strictEqual(sandboxesNewContent("visitor"), false);
		assert.strictEqual(sandboxesNewContent(undefined), false);
	});
});
