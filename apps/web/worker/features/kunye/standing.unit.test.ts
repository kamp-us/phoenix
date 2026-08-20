/**
 * `promotionBarFor` decides WHICH karma bar a çaylak faces from one fact: whether they
 * hold an active vouch (#1316). The frontend must never hardcode a bar, since the live
 * bar depends on vouch-exists.
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
 * The create-time sandbox rule is shared by BOTH sides of a write (#4282). They must
 * agree: a client that guesses differently renders a çaylak's comment as published for
 * the whole optimistic window — the false-publish this closes.
 */
describe("sandboxesNewContent", () => {
	it("a çaylak's new content lands sandboxed", () => {
		assert.strictEqual(sandboxesNewContent("çaylak"), true);
	});

	it("a yazar's new content is live", () => {
		assert.strictEqual(sandboxesNewContent("yazar"), false);
	});

	// An unresolved tier must not guess `true` — an unwarranted `incelemede` on a
	// yazar's comment is as dishonest as a missing one on a çaylak's.
	it("a visitor and an unresolved tier both read false", () => {
		assert.strictEqual(sandboxesNewContent("visitor"), false);
		assert.strictEqual(sandboxesNewContent(undefined), false);
	});
});
