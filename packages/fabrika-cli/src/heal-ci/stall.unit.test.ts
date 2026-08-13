import {describe, expect, it} from "vitest";
import {classifyStall, type StallFacts, strandAgeMinutes} from "./stall.ts";

/** A PR with nothing wrong and nobody on it: the base every arm is turned on individually from. */
const QUIET: StallFacts = {
	open: true,
	wedged: false,
	surfaceGap: false,
	ci: "green",
	linkageRefused: false,
	humanBlocked: false,
	hasOwner: false,
	ownerIdleMinutes: null,
	behindBase: 0,
	queued: false,
	mergeIntentArmed: false,
	gatesSatisfied: true,
	dwellMinutes: 45,
	driftCommits: 10,
};

const token = (facts: Partial<StallFacts>) => classifyStall({...QUIET, ...facts}).token;

describe("the chain is ordered, and the order is the contract", () => {
	it("takes not-open first, whatever else is true of the PR", () => {
		expect(token({open: false, wedged: true, ci: "red"})).toBe("not-open");
	});

	it("takes wedged above every other blocking state", () => {
		expect(token({wedged: true, surfaceGap: true, ci: "red"})).toBe("wedged");
	});

	it("reports check-surface above red — the gap is the cause the log repair cannot reach", () => {
		expect(token({surfaceGap: true, ci: "red"})).toBe("check-surface");
	});

	it("skips the surface arm when the protection surface is unprobeable, never passes it", () => {
		expect(token({surfaceGap: null, ci: "red"})).toBe("red");
	});

	it("ranks attended above every strand class", () => {
		expect(token({hasOwner: true, ownerIdleMinutes: 2, ci: "pending"})).toBe("attended");
	});
});

describe("arm 7 takes any positive signal of motion", () => {
	it.each([
		["a live queue entry", {queued: true}],
		["an armed merge intent", {mergeIntentArmed: true}],
		["CI running at this head", {ci: "pending" as const}],
		["an owner inside the dwell", {hasOwner: true, ownerIdleMinutes: 44}],
	])("reads %s as attended", (_label, facts) => {
		expect(token(facts)).toBe("attended");
	});
});

describe("arm 8 is the whole owner-exists complement of arm 7", () => {
	it("fires on inactivity past the dwell", () => {
		const verdict = classifyStall({...QUIET, hasOwner: true, ownerIdleMinutes: 200});
		expect(verdict.token).toBe("claim-stale");
		expect(verdict.staleReason).toBe("inactivity");
	});

	it("fires on ground drift even when the activity stamp is fresh enough to read", () => {
		const verdict = classifyStall({
			...QUIET,
			hasOwner: true,
			ownerIdleMinutes: 200,
			behindBase: 14,
		});
		expect(verdict.staleReason).toBe("ground-drift");
	});

	it("reads an unreadable activity stamp as stale, which is the fail-safe direction", () => {
		const verdict = classifyStall({...QUIET, hasOwner: true, ownerIdleMinutes: null});
		expect(verdict.token).toBe("claim-stale");
		expect(verdict.staleReason).toBe("unreadable-activity");
	});
});

describe("arms 9 and 10 partition the unowned remainder", () => {
	it("reads a satisfied gate with nobody shipping it as gated-unshipped", () => {
		expect(token({gatesSatisfied: true})).toBe("gated-unshipped");
	});

	it("reads a missing verdict as ungated", () => {
		expect(token({gatesSatisfied: false})).toBe("ungated");
	});

	it("reads a PR with zero required namespaces as gated-unshipped, vacuously", () => {
		expect(token({gatesSatisfied: true, ci: "none"})).toBe("gated-unshipped");
	});
});

describe("strandAgeMinutes", () => {
	const now = Date.parse("2026-08-08T02:00:00Z");

	it("measures from the LATER of the head push and the last activity", () => {
		expect(strandAgeMinutes("2026-08-08T00:00:00Z", "2026-08-08T01:30:00Z", now)).toBe(30);
	});

	it("floors at zero rather than reporting a negative age", () => {
		expect(strandAgeMinutes("2026-08-08T03:00:00Z", null, now)).toBe(0);
	});

	it("falls back to zero when neither stamp is readable", () => {
		expect(strandAgeMinutes(null, null, now)).toBe(0);
	});
});
