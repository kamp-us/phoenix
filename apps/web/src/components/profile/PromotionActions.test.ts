/**
 * `PromotionActions` decision coverage (#1206) — the mod-direct promote
 * call→outcome→copy mapping, factored DOM-free (the `flagGateChild` /
 * `toProfileStatsState` pure-extraction idiom; `apps/web/src` has no jsdom). Proves
 * `user.promote`'s `{result, error}` lands on the right lowercase-Turkish status,
 * including the authority-denial outcome. (The vouch UI is a deferred slice — only
 * the mod-direct surface is built here.)
 */
import {describe, expect, it} from "vitest";
import {
	promoteOutcome,
	promotionOutcomeMessage,
	shouldShowPromotionActions,
} from "./PromotionActions";

const denied = {code: "UNAUTHORIZED", message: "x"};
const oops = {code: "INTERNAL", message: "x"};

describe("shouldShowPromotionActions — mirror the divan gate (mod-only + not-own-profile, #1841)", () => {
	it("shows for a moderator viewing ANOTHER user's profile", () => {
		expect(shouldShowPromotionActions(true, false)).toBe(true);
	});

	it("never shows for a non-moderator, matching the divan's promoteVisible gate", () => {
		expect(shouldShowPromotionActions(false, false)).toBe(false);
	});

	it("never shows on the viewer's OWN profile, even for a moderator (self-promotion is nonsensical)", () => {
		expect(shouldShowPromotionActions(true, true)).toBe(false);
	});

	it("stays hidden for a non-moderator on their own profile", () => {
		expect(shouldShowPromotionActions(false, true)).toBe(false);
	});
});

describe("promoteOutcome — moderator direct promote", () => {
	it("a flipped tier reads as promoted", () => {
		expect(promoteOutcome({promoted: true}, null)).toBe("promoted");
	});
	it("an already-yazar (no flip) reads as alreadyYazar", () => {
		expect(promoteOutcome({promoted: false}, null)).toBe("alreadyYazar");
	});
	it("an UNAUTHORIZED denial reads as denied (the invisible moderation gate)", () => {
		expect(promoteOutcome(null, denied)).toBe("denied");
	});
	it("any other error reads as error", () => {
		expect(promoteOutcome(null, oops)).toBe("error");
	});
});

describe("promotionOutcomeMessage — lowercase Turkish, state as words", () => {
	it("every outcome maps to a non-empty lowercase message", () => {
		const outcomes = ["promoted", "alreadyYazar", "denied", "error"] as const;
		for (const o of outcomes) {
			const msg = promotionOutcomeMessage(o);
			expect(msg.length).toBeGreaterThan(0);
			expect(msg).toBe(msg.toLowerCase());
		}
	});
	it("a denial tells the user they lack authority, not that the target doesn't exist", () => {
		expect(promotionOutcomeMessage("denied")).toContain("yetkin yok");
	});
});
