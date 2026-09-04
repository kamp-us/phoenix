import {describe, expect, it} from "vitest";
import {
	type ActorStanding,
	actorIdentityLabel,
	bildirilenLabel,
	buAktorLabel,
	drawerDefaultOpen,
	drawerKeyToAction,
	hopTarget,
	kaldirilanLabel,
	kefilDurumuLabel,
	modRecordVerdicts,
	uretimLabel,
} from "./actor-drawer";

const standing = (over: Partial<ActorStanding> = {}): ActorStanding => ({
	tier: "çaylak",
	karma: 12,
	priorRemovals: 2,
	distinctReporters: 5,
	definitionCount: 4,
	postCount: 1,
	commentCount: 7,
	kefil: false,
	reportedTargets: 3,
	...over,
});

describe("drawerKeyToAction — the drawer's own bindings", () => {
	it("A toggles the drawer, V hops to kefil, M hops to moderation", () => {
		expect(drawerKeyToAction("A")).toEqual({kind: "toggleDrawer"});
		expect(drawerKeyToAction("V")).toEqual({kind: "hopKefil"});
		expect(drawerKeyToAction("M")).toEqual({kind: "hopModeration"});
	});

	it("ignores lowercase (mid-typing) and unbound keys — the loop then owns them", () => {
		expect(drawerKeyToAction("a")).toBeNull();
		expect(drawerKeyToAction("v")).toBeNull();
		expect(drawerKeyToAction("m")).toBeNull();
		expect(drawerKeyToAction("j")).toBeNull();
	});
});

describe("hopTarget — the cross-mode hop lands the same actor in the target chamber", () => {
	it("V reaches the kefil rite, M reaches the moderation record", () => {
		expect(hopTarget({kind: "hopKefil"})).toBe("kefil");
		expect(hopTarget({kind: "hopModeration"})).toBe("raporlar");
	});

	it("a plain toggle is not a chamber hop", () => {
		expect(hopTarget({kind: "toggleDrawer"})).toBeNull();
	});
});

describe("drawerDefaultOpen — desktop-first (founder call)", () => {
	it("docks open on desktop, closed on a narrow surface", () => {
		expect(drawerDefaultOpen(true)).toBe(true);
		expect(drawerDefaultOpen(false)).toBe(false);
	});
});

describe("modRecordVerdicts — the kefil-mode human-judgment guard (ADR 0138 §3)", () => {
	it("NEVER auto-verdicts in kefil mode — the record only informs the human", () => {
		expect(modRecordVerdicts("kefil")).toBe(false);
	});

	it("verdicts in the moderation chamber, where the record IS the thing judged", () => {
		expect(modRecordVerdicts("raporlar")).toBe(true);
	});
});

describe("actorIdentityLabel — @handle · tier · karma", () => {
	it("joins the resolved clauses", () => {
		expect(actorIdentityLabel("kaan", standing())).toBe("@kaan · çaylak · 12 karma");
	});

	it("drops an unresolved clause without fabricating it", () => {
		expect(actorIdentityLabel(null, standing({tier: "yazar", karma: 240}))).toBe(
			"yazar · 240 karma",
		);
	});

	it("is null when neither handle nor tier resolves (anonymized actor)", () => {
		expect(actorIdentityLabel(null, standing({tier: null, karma: null}))).toBeNull();
	});
});

describe("uretimLabel — the actor's live content footprint", () => {
	it("gives each count its own clause, singular where the count is 1", () => {
		expect(uretimLabel(standing())).toEqual({
			frame: {key: "divan.actor.uretim"},
			definitions: {key: "divan.count.definitions.other", params: {count: 4}},
			posts: {key: "divan.count.posts.one", params: {count: 1}},
			comments: {key: "divan.count.comments.other", params: {count: 7}},
		});
	});

	it("renders faithful zeros for a real newcomer — 0 is not absence", () => {
		expect(uretimLabel(standing({definitionCount: 0, postCount: 0, commentCount: 0}))).toEqual({
			frame: {key: "divan.actor.uretim"},
			definitions: {key: "divan.count.definitions.other", params: {count: 0}},
			posts: {key: "divan.count.posts.other", params: {count: 0}},
			comments: {key: "divan.count.comments.other", params: {count: 0}},
		});
	});

	it("is null when the counts are unresolved (no fabricated footprint)", () => {
		expect(uretimLabel(standing({definitionCount: null}))).toBeNull();
	});
});

describe("kaldirilanLabel — the prior-removals trust tell", () => {
	it("counts removals when the actor has them", () => {
		expect(kaldirilanLabel(2)).toEqual({key: "divan.actor.record.removed", params: {count: 2}});
	});

	it("reads temiz at zero (the value no longer re-states the sicil key), null when unresolved", () => {
		expect(kaldirilanLabel(0)).toEqual({key: "divan.actor.record.clean"});
		expect(kaldirilanLabel(null)).toBeNull();
	});
});

describe("bildirilenLabel — the pile-on breadth tell", () => {
	it("counts distinct reporters (bare count under the bildiren key), clamped to at least 1", () => {
		expect(bildirilenLabel(7)).toEqual({key: "divan.actor.reporters.other", params: {count: 7}});
		expect(bildirilenLabel(0)).toEqual({key: "divan.actor.reporters.one", params: {count: 1}});
	});
});

describe("kefilDurumuLabel — the vouch tell", () => {
	it("reads kefilli / kefilsiz, null when unresolved", () => {
		expect(kefilDurumuLabel(true)).toEqual({key: "divan.actor.kefil.yes"});
		expect(kefilDurumuLabel(false)).toEqual({key: "divan.actor.kefil.no"});
		expect(kefilDurumuLabel(null)).toBeNull();
	});
});

describe("buAktorLabel — the #1855 remove-the-wave entry point", () => {
	it("counts the actor's other reported targets (bare under the bu aktör key)", () => {
		expect(buAktorLabel(3)).toEqual({key: "divan.actor.otherReported.some", params: {count: 3}});
	});

	it("reads the clean line at 0/1, null when unresolved", () => {
		expect(buAktorLabel(1)).toEqual({key: "divan.actor.otherReported.none"});
		expect(buAktorLabel(0)).toEqual({key: "divan.actor.otherReported.none"});
		expect(buAktorLabel(null)).toBeNull();
	});
});
