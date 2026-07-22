import {describe, expect, it} from "vitest";
import {
	extractHealTargets,
	formatDuration,
	healItemBody,
	healItemTitle,
	healTargetMarker,
	type PrSnapshot,
	parseClosingRefs,
	planHealItems,
} from "./orphan-heal.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-07-19T12:00:00Z");
const GRACE = 6 * HOUR;

const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
	number: over.number ?? 100,
	isDraft: over.isDraft ?? false,
	ci: over.ci ?? "red",
	// default: red 8h ago (past a 6h grace)
	redSince: "redSince" in over ? over.redSince : "2026-07-19T04:00:00Z",
	laneState: over.laneState ?? "laneless",
	failingCheck: over.failingCheck,
});

const plan = (prs: ReadonlyArray<PrSnapshot>, targets: ReadonlyArray<number> = []) =>
	planHealItems(prs, {graceMs: GRACE, now: NOW, existingHealTargets: new Set(targets)});

describe("planHealItems — the orphan gate (all conditions must hold to emit)", () => {
	it("flags an open, non-draft, CI-red, laneless PR red past the grace window", () => {
		const {emit, skip} = plan([pr({number: 3501})]);
		expect(skip).toHaveLength(0);
		expect(emit).toHaveLength(1);
		expect(emit[0]?.number).toBe(3501);
		expect(emit[0]?.redForMs).toBe(8 * HOUR);
	});

	it("carries the failing check name into the emit item", () => {
		const {emit} = plan([pr({failingCheck: "lint / format / typecheck"})]);
		expect(emit[0]?.failingCheck).toBe("lint / format / typecheck");
	});
});

describe("planHealItems — each gate skips with the FIRST failing reason", () => {
	it("skips a draft PR", () => {
		const {emit, skip} = plan([pr({isDraft: true})]);
		expect(emit).toHaveLength(0);
		expect(skip[0]?.reason).toBe("draft");
	});

	it("skips a green / pending / unknown PR (ci-not-red)", () => {
		for (const ci of ["green", "pending", "unknown"] as const) {
			const {emit, skip} = plan([pr({ci})]);
			expect(emit).toHaveLength(0);
			expect(skip[0]?.reason).toBe("ci-not-red");
		}
	});

	it("skips a PR that is in an engine lane (the boundary — engines heal owned lanes)", () => {
		const {emit, skip} = plan([pr({laneState: "laned"})]);
		expect(emit).toHaveLength(0);
		expect(skip[0]?.reason).toBe("in-engine-lane");
	});

	it("defers a PR whose lane state could not be read, rather than filing against it", () => {
		const {emit, skip} = plan([pr({laneState: "unknown"})]);
		expect(emit).toHaveLength(0);
		expect(skip[0]?.reason).toBe("lane-state-unknown");
	});

	it("default-denies a red PR with no red-since anchor (grace unmeasurable)", () => {
		const {emit, skip} = plan([pr({redSince: undefined})]);
		expect(emit).toHaveLength(0);
		expect(skip[0]?.reason).toBe("no-red-since");
	});

	it("default-denies a red PR with an unparseable red-since", () => {
		const {skip} = plan([pr({redSince: "not-a-date"})]);
		expect(skip[0]?.reason).toBe("no-red-since");
	});

	it("skips a PR red for less than the grace window", () => {
		const {emit, skip} = plan([pr({redSince: "2026-07-19T09:00:00Z"})]); // red 3h < 6h grace
		expect(emit).toHaveLength(0);
		expect(skip[0]?.reason).toBe("within-grace");
	});

	it("gate order: a draft that is also green skips as draft (first gate wins)", () => {
		const {skip} = plan([pr({isDraft: true, ci: "green"})]);
		expect(skip[0]?.reason).toBe("draft");
	});
});

describe("planHealItems — idempotency (never a second heal-item)", () => {
	it("skips a PR that already has an open heal-item", () => {
		const {emit, skip} = plan([pr({number: 3501})], [3501]);
		expect(emit).toHaveLength(0);
		expect(skip[0]?.reason).toBe("heal-item-exists");
	});

	it("re-running over the same orphan with its heal-item present emits nothing", () => {
		const orphan = pr({number: 3501});
		const first = plan([orphan]); // no existing item yet
		expect(first.emit.map((e) => e.number)).toEqual([3501]);
		const second = plan([orphan], [3501]); // item now exists
		expect(second.emit).toHaveLength(0);
	});

	it("emits only the orphans without an existing heal-item across a mixed batch", () => {
		const batch = [pr({number: 1}), pr({number: 2}), pr({number: 3})];
		const {emit} = plan(batch, [2]);
		expect(emit.map((e) => e.number)).toEqual([1, 3]);
	});
});

describe("heal-item marker round-trip (the idempotency read/write pair)", () => {
	it("healTargetMarker and extractHealTargets round-trip a PR number", () => {
		expect(healTargetMarker(3501)).toBe("orphan-heal-target: #3501");
		expect(extractHealTargets(healTargetMarker(3501))).toEqual([3501]);
	});

	it("extracts the target embedded in a full heal-item body", () => {
		const body = healItemBody(
			{number: 3501, failingCheck: "ci", redForMs: 8 * HOUR},
			{repo: "kamp-us/phoenix", sourceIssue: 3650},
		);
		expect(extractHealTargets(body)).toEqual([3501]);
	});

	it("returns no targets for a body without the marker", () => {
		expect(extractHealTargets("just some issue text about #3501")).toEqual([]);
	});
});

describe("heal-item rendering", () => {
	it("titles the heal-item deterministically", () => {
		expect(healItemTitle(3501)).toBe("heal red CI on PR #3501");
	});

	it("body links the PR, names the failing check, and cites the boundary ruling", () => {
		const body = healItemBody(
			{number: 3501, failingCheck: "lint", redForMs: 8 * HOUR},
			{repo: "kamp-us/phoenix", sourceIssue: 3650},
		);
		expect(body).toContain("https://github.com/kamp-us/phoenix/pull/3501");
		expect(body).toContain("`lint`");
		expect(body).toContain("#3532");
	});

	it("body degrades gracefully when no failing check is known", () => {
		const body = healItemBody(
			{number: 3501, redForMs: 8 * HOUR},
			{repo: "kamp-us/phoenix", sourceIssue: 3650},
		);
		expect(body).toContain("see the PR's checks tab");
	});
});

describe("parseClosingRefs — engine-lane derivation input", () => {
	it("parses the standard closing keywords", () => {
		expect(parseClosingRefs("Fixes #12")).toEqual([12]);
		expect(parseClosingRefs("Closes #7 and resolves #8")).toEqual([7, 8]);
		expect(parseClosingRefs("Resolved: #99")).toEqual([99]);
	});

	it("ignores a bare #ref without a closing keyword (a plain cross-link is not a lane)", () => {
		expect(parseClosingRefs("see #12, related to #34")).toEqual([]);
	});

	it("returns empty for a body that closes nothing (the orphan shape)", () => {
		expect(parseClosingRefs("docs(adr): 0195 amend 0189")).toEqual([]);
	});
});

describe("formatDuration", () => {
	it("renders sub-hour durations as minutes", () => {
		expect(formatDuration(45 * 60 * 1000)).toBe("45m");
	});
	it("renders multi-hour durations as hours and minutes", () => {
		expect(formatDuration(8 * HOUR + 30 * 60 * 1000)).toBe("8h 30m");
	});
	it("clamps a negative duration to 0m", () => {
		expect(formatDuration(-1000)).toBe("0m");
	});
});
