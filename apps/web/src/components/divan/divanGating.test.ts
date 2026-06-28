/**
 * The divan surface's gating contract (#1290, epic #1202) — the pure render
 * decisions asserted without a DOM (the pure-extraction idiom of `flagGateChild`
 * / `shouldShowOnramp`; `apps/web/src` has no jsdom/testing-library). These are
 * the AC the surface lives or dies on: flag-off ⇒ no route + no topbar entry;
 * çaylak/visitor ⇒ no topbar entry; vouch disabled until the detail is opened.
 */
import {describe, expect, it} from "vitest";
import {
	canVouch,
	caylakLabel,
	itemKindLabel,
	parseBacklogItemId,
	promoteOutcome,
	promoteOutcomeMessage,
	promoteVisible,
	shouldRenderDivanPage,
	shouldShowDivanEntry,
	vouchOutcome,
	vouchOutcomeMessage,
	vouchVisible,
} from "./divanGating";

describe("shouldRenderDivanPage — the flag-gated route", () => {
	it("renders the page when the loop flag is on", () => {
		expect(shouldRenderDivanPage(true)).toBe(true);
	});

	it("renders the 404 (route absent) when the flag is off", () => {
		// loading / fetch-error / undeclared all resolve to `false` upstream, so the
		// route is absent in every flag failure mode too.
		expect(shouldRenderDivanPage(false)).toBe(false);
	});
});

describe("shouldShowDivanEntry — the yazar/mod-only topbar entry", () => {
	it("shows the entry only when the flag is on AND access was granted", () => {
		expect(shouldShowDivanEntry(true, true)).toBe(true);
	});

	it("hides the entry when the flag is off, even if access was (somehow) granted", () => {
		expect(shouldShowDivanEntry(false, true)).toBe(false);
	});

	it("hides the entry for a denied (çaylak/visitor) probe even with the flag on", () => {
		expect(shouldShowDivanEntry(true, false)).toBe(false);
	});

	it("hides the entry when both are false", () => {
		expect(shouldShowDivanEntry(false, false)).toBe(false);
	});
});

describe("vouchVisible / canVouch — the yazar vouch affordance, gated on detail-open", () => {
	it("is visible to a yazar", () => {
		expect(vouchVisible("yazar")).toBe(true);
	});

	it("is invisible to a çaylak, a visitor, and a not-yet-loaded tier", () => {
		expect(vouchVisible("çaylak")).toBe(false);
		expect(vouchVisible("visitor")).toBe(false);
		expect(vouchVisible(undefined)).toBe(false);
	});

	it("a yazar cannot vouch until the çaylak detail is opened", () => {
		expect(canVouch("yazar", false)).toBe(false);
	});

	it("a yazar can vouch once the detail is opened", () => {
		expect(canVouch("yazar", true)).toBe(true);
	});

	it("a non-yazar can never vouch, opened detail or not", () => {
		expect(canVouch("çaylak", true)).toBe(false);
		expect(canVouch("visitor", true)).toBe(false);
	});
});

describe("promoteVisible — the mod-only yazar-yap affordance, keyed on isModerator", () => {
	it("shows for a moderator (the trusted server-authoritative signal)", () => {
		expect(promoteVisible(true)).toBe(true);
	});

	it("shows for a dual-role yazar+moderator — the #1320 bug (tier-keying hid it)", () => {
		// isModerator is independent of tier; a founding author-mod (#1207) reads
		// tier "yazar" yet must still see promote.
		expect(promoteVisible(true)).toBe(true);
	});

	it("hides from a non-moderator (a yazar-only viewer keeps only kefil ol)", () => {
		expect(promoteVisible(false)).toBe(false);
	});
});

describe("caylakLabel — the çaylak's display handle", () => {
	it("prefers the display name", () => {
		expect(caylakLabel("Ada Lovelace", "ada")).toBe("Ada Lovelace");
	});

	it("falls back to @username when there is no display name", () => {
		expect(caylakLabel(null, "ada")).toBe("@ada");
		expect(caylakLabel("   ", "ada")).toBe("@ada");
	});

	it("falls back to the lowercase-Turkish çaylak when there is neither", () => {
		expect(caylakLabel(null, null)).toBe("çaylak");
		expect(caylakLabel("", "  ")).toBe("çaylak");
	});
});

describe("itemKindLabel — lowercase-Turkish per-kind noun", () => {
	it("maps each kind to its Turkish noun", () => {
		expect(itemKindLabel("definition")).toBe("tanım");
		expect(itemKindLabel("post")).toBe("gönderi");
		expect(itemKindLabel("comment")).toBe("yorum");
	});
});

describe("parseBacklogItemId — the <kind>:<itemId> → report target", () => {
	it("splits a well-formed composite id", () => {
		expect(parseBacklogItemId("definition:def-1")).toEqual({
			targetKind: "definition",
			targetId: "def-1",
		});
		expect(parseBacklogItemId("post:p-9")).toEqual({targetKind: "post", targetId: "p-9"});
		expect(parseBacklogItemId("comment:c-3")).toEqual({targetKind: "comment", targetId: "c-3"});
	});

	it("keeps a colon inside the item id (splits on the FIRST colon only)", () => {
		expect(parseBacklogItemId("post:a:b")).toEqual({targetKind: "post", targetId: "a:b"});
	});

	it("rejects an unknown kind, a missing half, or a malformed id", () => {
		expect(parseBacklogItemId("user:u-1")).toBeNull();
		expect(parseBacklogItemId("definition:")).toBeNull();
		expect(parseBacklogItemId(":def-1")).toBeNull();
		expect(parseBacklogItemId("definition")).toBeNull();
		expect(parseBacklogItemId("")).toBeNull();
	});
});

describe("promoteOutcome — the user.promote receipt → outcome", () => {
	it("denied wins over everything", () => {
		expect(promoteOutcome(true, true, false)).toBe("denied");
	});

	it("a failure (non-denial) maps to error", () => {
		expect(promoteOutcome(undefined, false, true)).toBe("error");
	});

	it("promoted vs already-yazar by the receipt flag", () => {
		expect(promoteOutcome(true, false, false)).toBe("promoted");
		expect(promoteOutcome(false, false, false)).toBe("alreadyYazar");
	});

	it("every outcome has lowercase-Turkish copy", () => {
		for (const o of ["promoted", "alreadyYazar", "denied", "error"] as const) {
			const msg = promoteOutcomeMessage(o);
			expect(msg).toBe(msg.toLowerCase());
			expect(msg.length).toBeGreaterThan(0);
		}
	});
});

describe("vouchOutcome — the user.vouch receipt/code → outcome", () => {
	it("the concurrent-vouch cap maps to limit", () => {
		expect(vouchOutcome(undefined, "VOUCH_LIMIT_REACHED", false)).toBe("limit");
	});

	it("a yazar-floor denial maps to denied", () => {
		expect(vouchOutcome(undefined, "FORBIDDEN", false)).toBe("denied");
		expect(vouchOutcome(undefined, "UNAUTHORIZED", false)).toBe("denied");
	});

	it("a non-denial failure maps to error", () => {
		expect(vouchOutcome(undefined, null, true)).toBe("error");
	});

	it("promoted (tandem fired) vs recorded (below the bar) by the receipt flag", () => {
		expect(vouchOutcome(true, null, false)).toBe("promoted");
		expect(vouchOutcome(false, null, false)).toBe("recorded");
	});

	it("every outcome has lowercase-Turkish copy", () => {
		for (const o of ["promoted", "recorded", "limit", "denied", "error"] as const) {
			const msg = vouchOutcomeMessage(o);
			expect(msg).toBe(msg.toLowerCase());
			expect(msg.length).toBeGreaterThan(0);
		}
	});
});
