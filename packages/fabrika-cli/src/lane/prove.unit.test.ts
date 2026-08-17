import {describe, expect, it} from "vitest";
import {
	claimOf,
	foldNamespaces,
	issueOf,
	judgeVerdicts,
	traceDiagnosis,
	tracePulls,
} from "./prove.ts";

describe("claimOf", () => {
	it("claims a pull request for a DONE out of build, verdicts for a PASS out of review", () => {
		expect(claimOf("DONE", "build")).toEqual({_tag: "OpenPull"});
		expect(claimOf("PASS", "review")).toEqual({_tag: "HeadVerdicts"});
	});

	it("claims nothing for the events no board read can falsify", () => {
		for (const [event, leaf] of [
			["DONE", "ship"],
			["BLOCKED", "build"],
			["FAIL", "review"],
			["WIP", "queued"],
			["UNBLOCKED", "blocked"],
		]) {
			expect(claimOf(event ?? "", leaf ?? "")._tag).toBe("None");
		}
	});

	it("claims nothing on a machine that renames the states, rather than refusing it", () => {
		const claim = claimOf("DONE", "coding");
		expect(claim._tag).toBe("None");
		expect(claim._tag === "None" && claim.why).toContain("coding");
	});
});

describe("issueOf", () => {
	it("reads an emitted region's child number, else the lane's own id", () => {
		expect(issueOf("issue_5749", "5680")).toBe(5749);
		expect(issueOf("issue", "5747")).toBe(5747);
	});

	it("answers null where neither names a number — never a plausible issue", () => {
		expect(issueOf("issue", "spike-a")).toBeNull();
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
		const proof = foldNamespaces([row("review-code", "pass"), row("governance", "pass")], 4318);
		expect(proof._tag).toBe("Proven");
	});

	it("reads a missing namespace as in flight — re-read, record nothing", () => {
		const proof = foldNamespaces([row("review-code", "pass"), row("governance", "absent")], 4318);
		expect(proof._tag).toBe("InFlight");
		expect(proof._tag === "InFlight" && proof.what).toContain("governance (absent)");
	});

	it("reads a current-head FAIL as a contradiction, never as an unfinished review", () => {
		const proof = foldNamespaces([row("review-code", "fail"), row("governance", "absent")], 4318);
		expect(proof._tag).toBe("Contradicted");
		expect(proof._tag === "Contradicted" && proof.what).toContain("review-code");
	});
});
