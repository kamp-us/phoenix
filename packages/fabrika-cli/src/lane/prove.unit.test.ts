import {describe, expect, it} from "vitest";
import {
	childLaneBranches,
	claimOf,
	epicOf,
	foldNamespaces,
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
		expect(claimOf("PASS", "review", SINGLE)).toEqual({_tag: "HeadVerdicts"});
	});

	it("claims the same two artifacts for an epic tail — the tail is the one PR (ADR 0285)", () => {
		expect(claimOf("DONE", "build", TAIL)).toEqual({_tag: "OpenPull"});
		expect(claimOf("PASS", "review", TAIL)).toEqual({_tag: "HeadVerdicts"});
	});

	it("claims a range for a child, which never opens a PR to claim", () => {
		expect(claimOf("DONE", "build", CHILD)).toEqual({_tag: "RangeCommits", epic: 5800});
		expect(claimOf("PASS", "review", CHILD)).toEqual({_tag: "RangeVerdict", epic: 5800});
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

describe("traceRange", () => {
	const commit = (issue: number) => `feat(lane): do the thing (#${issue})`;
	const carrying = {
		branch: "build/5829-prove-range-arms-154c981b",
		tip: "03135b9",
		messages: [commit(5829)],
	};

	it("traces the one branch whose commits name the child, and counts them", () => {
		expect(traceRange(5829, "epic/5800", [carrying])).toEqual({
			_tag: "One",
			branch: carrying.branch,
			tip: "03135b9",
			commits: 1,
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
	const row = (namespace: string, state: "pass" | "fail" | "absent") => ({
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
});
