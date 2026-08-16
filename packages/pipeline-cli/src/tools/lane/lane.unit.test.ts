/**
 * Pure-core tests for `lane` (#3964): the founder-set constants, the single-place platform
 * discriminator, the closing-keyword parse, the occupancy predicate (including the
 * issue-key/PR-key coalescing nothing in the keyspace does), the counts, the ADR-0092
 * empty-scan fork, and the report. No IO — the `gh api` seam is crossed in `github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	classify,
	coalesce,
	LANE_CAPACITY,
	type LaneIssue,
	type LanePr,
	PLATFORM_LABELS,
	PLATFORM_QUOTA,
	parseCloses,
	renderReport,
	status,
} from "./lane.ts";

const issue = (
	number: number,
	options: {labels?: ReadonlyArray<string>; holder?: string | null} = {},
): LaneIssue => ({
	number,
	title: `issue ${number}`,
	labels: options.labels ?? ["type:feature"],
	holder: options.holder === undefined ? "sid-a" : options.holder,
});

const pr = (
	number: number,
	options: {closes?: ReadonlyArray<number>; draft?: boolean} = {},
): LanePr => ({
	number,
	title: `pr ${number}`,
	closes: options.closes ?? [],
	draft: options.draft ?? false,
});

describe("the founder-set budget", () => {
	it("is 6 lanes with a platform quota of 2, named in one place (#3227)", () => {
		expect(LANE_CAPACITY).toBe(6);
		expect(PLATFORM_QUOTA).toBe(2);
	});
});

describe("classify — the one platform discriminator", () => {
	it("is EXACTLY the two existing labels — no new label or field is introduced", () => {
		expect([...PLATFORM_LABELS]).toEqual(["area:infra", "axis:pipeline-hardening"]);
	});

	it.each([...PLATFORM_LABELS])("%s makes the lane platform", (label) => {
		expect(classify(["type:chore", label])).toBe("platform");
	});

	it("anything else is product", () => {
		expect(classify(["type:feature", "p1", "area:web"])).toBe("product");
	});

	it("a look-alike label does NOT classify platform (exact match, not a prefix)", () => {
		expect(classify(["area:infrastructure", "axis:pipeline-hardening-ish"])).toBe("product");
	});
});

describe("parseCloses", () => {
	it.each([
		"Closes #12",
		"closes #12",
		"Fixes #12",
		"fixed #12",
		"Resolves #12",
		"close: #12",
	])("reads GitHub's closing keyword form %s", (body) => {
		expect(parseCloses(body)).toEqual([12]);
	});

	it("ignores a bare reference that GitHub would not close on", () => {
		expect(parseCloses("Refs #12, see also #13")).toEqual([]);
	});

	it("de-duplicates and preserves body order", () => {
		expect(parseCloses("Closes #9\n\nAlso fixes #4 and closes #9 again.")).toEqual([9, 4]);
	});
});

describe("coalesce — the lane-occupancy predicate", () => {
	it("a claimed open issue with no PR is one lane, at the `claimed` stage", () => {
		const lanes = coalesce({issues: [issue(100)], prs: []});
		expect(lanes).toHaveLength(1);
		expect(lanes[0]).toMatchObject({key: "issue-100", stage: "claimed", holder: "sid-a"});
	});

	it("an UNCLAIMED open issue holds no lane — occupancy is the claim, not the backlog", () => {
		expect(coalesce({issues: [issue(100, {holder: null})], prs: []})).toEqual([]);
	});

	it("an issue and its PR are ONE lane, not two — the key split the tracker cannot bridge", () => {
		const lanes = coalesce({issues: [issue(100)], prs: [pr(200, {closes: [100]})]});
		expect(lanes).toHaveLength(1);
		expect(lanes[0]).toMatchObject({key: "issue-100", issue: 100, prs: [200], stage: "in-review"});
		expect(lanes[0]?.trackerKeys).toEqual(["issue-100", "pr-200"]);
	});

	it("an open PR holds its issue's lane even after the claim was released", () => {
		const lanes = coalesce({
			issues: [issue(100, {holder: null})],
			prs: [pr(200, {closes: [100]})],
		});
		expect(lanes).toHaveLength(1);
		expect(lanes[0]).toMatchObject({key: "issue-100", stage: "in-review", holder: null});
	});

	it("a draft PR still holds its lane — a lane is unlanded work, not a merge-ready one", () => {
		const lanes = coalesce({issues: [], prs: [pr(200, {closes: [100], draft: true})]});
		expect(lanes).toHaveLength(1);
		expect(lanes[0]?.stage).toBe("in-review");
	});

	it("a PR closing several issues still holds ONE lane, anchored on the first link", () => {
		const lanes = coalesce({
			issues: [issue(100), issue(101, {holder: null})],
			prs: [pr(200, {closes: [100, 101]})],
		});
		expect(lanes.map((lane) => lane.key)).toEqual(["issue-100"]);
	});

	it("a PR that links no issue is its own lane, classified indeterminate not product", () => {
		const lanes = coalesce({issues: [], prs: [pr(200)]});
		expect(lanes[0]).toMatchObject({
			key: "pr-200",
			issue: null,
			classification: "indeterminate",
			trackerKeys: ["pr-200"],
		});
	});

	it("a PR linking an issue outside the scanned open set is indeterminate, never product", () => {
		const lanes = coalesce({issues: [], prs: [pr(200, {closes: [100]})]});
		expect(lanes[0]).toMatchObject({key: "issue-100", classification: "indeterminate"});
	});

	it("classifies each lane off its issue's labels", () => {
		const lanes = coalesce({
			issues: [issue(100, {labels: ["area:infra"]}), issue(101, {labels: ["type:feature"]})],
			prs: [],
		});
		expect(lanes.map((lane) => lane.classification)).toEqual(["platform", "product"]);
	});
});

describe("status", () => {
	it("counts unlanded lanes separately from stage — one number is what misled (#3964)", () => {
		const result = status({
			issues: [
				issue(100, {labels: ["area:infra"]}),
				issue(101),
				issue(102, {labels: ["axis:pipeline-hardening"]}),
			],
			prs: [pr(200, {closes: [101]})],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.counts).toEqual({
			unlanded: 3,
			claimed: 2,
			inReview: 1,
			platform: 2,
			product: 1,
			indeterminate: 0,
		});
		expect(result.capacity).toBe(LANE_CAPACITY);
		expect(result.platformQuota).toBe(PLATFORM_QUOTA);
	});

	it("reports zero lanes off a non-empty scan — an idle factory is a legitimate answer", () => {
		const result = status({issues: [issue(100, {holder: null})], prs: []});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.counts.unlanded).toBe(0);
		expect(result.scannedIssues).toBe(1);
	});

	it("fails closed on an empty scan — that is a broken read, not an idle factory (ADR 0092)", () => {
		expect(status({issues: [], prs: []})).toEqual({ok: false, reason: "empty-scan"});
	});
});

describe("renderReport", () => {
	it("names the unlanded total, the stage split, the quota, and the scanned scope", () => {
		const report = renderReport(
			status({issues: [issue(100, {labels: ["area:infra"]})], prs: [pr(200, {closes: [100]})]}),
		);
		expect(report).toContain("1 of 6 build lanes occupied");
		expect(report).toContain("0 claimed, 1 in-review");
		expect(report).toContain("1 platform of a quota of 2");
		expect(report).toContain("Scanned 1 open issue(s) and 1 open PR(s)");
		expect(report).toContain("issue-100");
	});

	it("states that a lane is unlanded work rather than a running agent", () => {
		const report = renderReport(status({issues: [issue(100)], prs: []}));
		expect(report).toContain("UNLANDED WORK, not a running agent");
	});

	it("explains the empty-scan refusal instead of printing a vacuous zero", () => {
		const report = renderReport(status({issues: [], prs: []}));
		expect(report).toContain("fail-closed (ADR 0092)");
	});
});
