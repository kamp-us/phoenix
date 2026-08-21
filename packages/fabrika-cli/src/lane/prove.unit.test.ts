import {describe, expect, it} from "vitest";
import {
	childLaneBranches,
	claimOf,
	epicOf,
	foldNamespaces,
	integratedFrom,
	issueOf,
	judgeVerdicts,
	roleOf,
	traceDiagnosis,
	tracePulls,
	traceRange,
} from "./prove.ts";

const SINGLE = {_tag: "Single"} as const;
const CHILD = {_tag: "Child", epic: 5800} as const;
const TAIL = {_tag: "Tail", epic: 5800} as const;

describe("epicOf and roleOf", () => {
	it("reads the epic off the tail task's own name, and calls every other task a child", () => {
		const tasks = ["issue_5824", "issue_5829", "epic_5800"];
		expect(epicOf(tasks)).toBe(5800);
		expect(roleOf("epic_5800", 5800)).toEqual(TAIL);
		expect(roleOf("issue_5829", 5800)).toEqual(CHILD);
	});

	it("calls a lane with no tail single — a machine that names no epic has no child regions", () => {
		expect(epicOf(["issue"])).toBeNull();
		expect(roleOf("issue", null)).toEqual(SINGLE);
	});
});

describe("claimOf", () => {
	it("claims a pull request for a DONE out of build, verdicts for a PASS out of review", () => {
		expect(claimOf("DONE", "build", SINGLE)).toEqual({_tag: "OpenPull"});
		expect(claimOf("PASS", "review", SINGLE)).toEqual({
			_tag: "HeadVerdicts",
			defers: ["review-ui"],
		});
	});

	/**
	 * The two review cells prove different halves, and only that split makes the machine's
	 * `review --PASS--> review:ui` arm walkable: proving `review-ui` of the event that *takes* the
	 * arm asked the lane for a verdict from the cell it had not entered (#6664/#6793).
	 */
	it("defers the routed namespace out of `review` and nothing out of `review:ui`", () => {
		expect(claimOf("PASS", "review:ui", SINGLE)).toEqual({_tag: "HeadVerdicts", defers: []});
		expect(claimOf("PASS", "review:ui", TAIL)).toEqual({_tag: "HeadVerdicts", defers: []});
	});

	it("claims the same two artifacts for an epic tail — the tail is the one PR (ADR 0285)", () => {
		expect(claimOf("DONE", "build", TAIL)).toEqual({_tag: "OpenPull"});
		expect(claimOf("PASS", "review", TAIL)).toEqual({
			_tag: "HeadVerdicts",
			defers: ["review-ui"],
		});
	});

	it("claims a range for a child, which never opens a PR to claim", () => {
		expect(claimOf("DONE", "build", CHILD)).toEqual({_tag: "RangeCommits", epic: 5800});
		expect(claimOf("PASS", "review", CHILD)).toEqual({_tag: "RangeVerdict", epic: 5800});
	});

	/** A child's regions carry no `review:ui` cell, so its range-scoped set has nowhere to defer to. */
	it("claims nothing for a child out of `review:ui`, a cell its regions do not have", () => {
		expect(claimOf("PASS", "review:ui", CHILD)._tag).toBe("None");
	});

	it("claims nothing for the events no read can falsify, in either shape", () => {
		for (const [event, leaf] of [
			["DONE", "ship"],
			["DONE", "integrate"],
			["BLOCKED", "build"],
			["FAIL", "review"],
			["WIP", "queued"],
			["UNBLOCKED", "blocked"],
		]) {
			expect(claimOf(event ?? "", leaf ?? "", SINGLE)._tag).toBe("None");
			expect(claimOf(event ?? "", leaf ?? "", CHILD)._tag).toBe("None");
		}
	});

	it("claims nothing on a machine that renames the states, rather than refusing it", () => {
		const claim = claimOf("DONE", "coding", SINGLE);
		expect(claim._tag).toBe("None");
		expect(claim._tag === "None" && claim.why).toContain("coding");
	});
});

describe("issueOf", () => {
	it("reads an emitted region's child number, the tail's epic number, else the lane's own id", () => {
		expect(issueOf("issue_5749", "5680")).toBe(5749);
		expect(issueOf("epic_5800", "5800")).toBe(5800);
		expect(issueOf("issue", "5747")).toBe(5747);
	});

	it("answers null where neither names a number — never a plausible issue", () => {
		expect(issueOf("issue", "spike-a")).toBeNull();
	});
});

describe("childLaneBranches", () => {
	it("nominates only the branches build branch's own grammar cut for this child", () => {
		const branches = [
			"main",
			"epic/5800",
			"build/5829-prove-range-arms-154c981b",
			"build/5824-emitter-reshape-aabbccdd",
			"build/pr-5891-aabbccdd",
			"build/5829-not-a-nonce",
		];
		expect(childLaneBranches(5829, branches)).toEqual(["build/5829-prove-range-arms-154c981b"]);
	});
});

describe("integratedFrom", () => {
	const TIP = "4cca8326";
	const EPIC_BEFORE = "ec3894d2";

	it("reads the epic branch as it stood off the integrating merge's first parent", () => {
		expect(
			integratedFrom(TIP, [
				{sha: "aaaa1111", parents: ["ec3894d3", "sibling1"]},
				{sha: "ec3894d3", parents: [EPIC_BEFORE, TIP]},
			]),
		).toBe(EPIC_BEFORE);
	});

	it("answers nothing for a tip no merge took in — a branch cut and never built on", () => {
		// The never-built tip IS an epic commit, so a later sibling merge names it as its FIRST
		// parent. Answering with that merge's second parent would hand back a sibling's fork point.
		expect(integratedFrom(TIP, [{sha: "aaaa1111", parents: [TIP, "sibling1"]}])).toBe(null);
	});

	it("takes the oldest merge when a tip was taken in twice", () => {
		expect(
			integratedFrom(TIP, [
				{sha: "bbbb2222", parents: ["later", TIP]},
				{sha: "ec3894d3", parents: [EPIC_BEFORE, TIP]},
			]),
		).toBe(EPIC_BEFORE);
	});
});

describe("traceRange", () => {
	const commit = (issue: number) => `feat(lane): do the thing (#${issue})`;
	const carrying = {
		branch: "build/5829-prove-range-arms-154c981b",
		base: "664eb9d",
		tip: "03135b9",
		messages: [commit(5829)],
	};

	it("traces the one branch whose commits name the child, and counts them", () => {
		expect(traceRange(5829, "epic/5800", [carrying])).toEqual({
			_tag: "One",
			branch: carrying.branch,
			base: "664eb9d",
			tip: "03135b9",
			commits: 1,
			naming: 1,
		});
	});

	it("counts the range whole and the naming commits apart, never one as the other", () => {
		const mixed = {
			...carrying,
			messages: [commit(5829), commit(5824), "chore: no issue in this subject"],
		};
		expect(traceRange(5829, "epic/5800", [mixed])).toEqual({
			_tag: "One",
			branch: carrying.branch,
			base: "664eb9d",
			tip: "03135b9",
			commits: 3,
			naming: 1,
		});
	});

	it("says nothing was built here when no branch was cut for the child", () => {
		const traced = traceRange(5829, "epic/5800", []);
		expect(traced._tag).toBe("None");
		expect(traced._tag === "None" && traced.why).toContain("no local branch in this tree");
	});

	it("keeps a cut-and-never-built branch apart from one carrying another child's work", () => {
		const empty = traceRange(5829, "epic/5800", [{...carrying, messages: []}]);
		expect(empty._tag === "None" && empty.why).toContain("cut and not built on");

		const foreign = traceRange(5829, "epic/5800", [{...carrying, messages: [commit(5824)]}]);
		expect(foreign._tag === "None" && foreign.why).toContain("names #5829");
	});

	it("keeps several carrying branches as their own answer rather than picking one", () => {
		const traced = traceRange(5829, "epic/5800", [
			carrying,
			{...carrying, branch: "build/5829-second-try-deadbeef"},
		]);
		expect(traced).toEqual({
			_tag: "Many",
			branches: [carrying.branch, "build/5829-second-try-deadbeef"],
		});
	});
});

describe("tracePulls", () => {
	const linking = {number: 4318, open: true, linkedIssue: 4312};

	it("traces the one open PR whose body links the issue", () => {
		expect(tracePulls(4312, [linking])).toEqual({_tag: "One", pr: 4318});
	});

	it("does not count a PR that only mentions the number, or one that has closed", () => {
		expect(tracePulls(4312, [{number: 4400, open: true, linkedIssue: null}])).toEqual({
			_tag: "None",
		});
		expect(tracePulls(4312, [{...linking, open: false}])).toEqual({_tag: "None"});
	});

	it("keeps several linking PRs as their own answer rather than picking the first", () => {
		const trace = tracePulls(4312, [linking, {number: 4319, open: true, linkedIssue: 4312}]);
		expect(trace).toEqual({_tag: "Many", prs: [4318, 4319]});
	});
});

describe("traceDiagnosis", () => {
	const comment = {id: 900, createdAt: "2026-08-16T02:00:00Z"};
	const labels = ["type:investigation", "status:triaged"];

	it("proves a no-PR outcome from the label and a comment written since the task entered build", () => {
		expect(traceDiagnosis(4312, labels, [comment], "2026-08-16T01:00:00Z")).toEqual({
			_tag: "Posted",
			commentId: 900,
		});
	});

	it("refuses when the issue is not one a no-PR outcome is legal on", () => {
		const traced = traceDiagnosis(4312, ["type:feature"], [comment], null);
		expect(traced._tag).toBe("Absent");
		expect(traced._tag === "Absent" && traced.why).toContain("type:investigation");
	});

	it("refuses on a comment that predates the build — a triage note is not a diagnosis", () => {
		const traced = traceDiagnosis(4312, labels, [comment], "2026-08-16T03:00:00Z");
		expect(traced._tag).toBe("Absent");
		expect(traced._tag === "Absent" && traced.why).toContain("no diagnosis");
	});
});

describe("judgeVerdicts", () => {
	const pass = {
		namespace: "review-code",
		polarity: "PASS",
		binding: "current",
		commentId: 1,
	} as const;

	it("rows every required namespace, including the ones nothing was written for", () => {
		expect(judgeVerdicts(["review-code", "governance"], [pass])).toEqual([
			{namespace: "review-code", state: "pass", commentId: 1},
			{namespace: "governance", state: "absent", commentId: null},
		]);
	});

	it("keeps stale and unknown apart from absent — three different reads", () => {
		const rows = judgeVerdicts(
			["review-code", "review-doc"],
			[
				{...pass, binding: "stale"},
				{...pass, namespace: "review-doc", binding: "unknown"},
			],
		);
		expect(rows.map((row) => row.state)).toEqual(["stale", "unknown"]);
	});
});

describe("foldNamespaces", () => {
	const row = (namespace: string, state: "pass" | "fail" | "absent" | "routed" | "stale") => ({
		namespace,
		state,
		commentId: null,
	});

	it("proves a PASS only when every derived namespace passes at the head", () => {
		const proof = foldNamespaces([row("review-code", "pass"), row("governance", "pass")], "#4318");
		expect(proof._tag).toBe("Proven");
	});

	it("reads a missing namespace as in flight — re-read, record nothing", () => {
		const proof = foldNamespaces(
			[row("review-code", "pass"), row("governance", "absent")],
			"#4318",
		);
		expect(proof._tag).toBe("InFlight");
		expect(proof._tag === "InFlight" && proof.what).toContain("governance (absent)");
	});

	it("reads a current-head FAIL as a contradiction, never as an unfinished review", () => {
		const proof = foldNamespaces(
			[row("review-code", "fail"), row("governance", "absent")],
			"#4318",
		);
		expect(proof._tag).toBe("Contradicted");
		expect(proof._tag === "Contradicted" && proof.what).toContain("review-code");
	});

	it("satisfies a routed namespace beside a pass — a route is an answer, not an absence", () => {
		const proof = foldNamespaces([row("review-code", "pass"), row("review-ui", "routed")], "#4318");
		expect(proof._tag).toBe("Proven");
		expect(proof._tag === "Proven" && proof.note).toContain("review-ui (routed)");
	});

	it("holds a route the head has moved past — it rows stale, and stale is not an answer", () => {
		const proof = foldNamespaces([row("review-code", "pass"), row("review-ui", "stale")], "#4318");
		expect(proof._tag).toBe("InFlight");
		expect(proof._tag === "InFlight" && proof.what).toContain("review-ui (stale)");
	});
});
