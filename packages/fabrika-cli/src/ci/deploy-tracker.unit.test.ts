import {assert, describe, it} from "@effect/vitest";
import {
	decide,
	factsFromEnv,
	type IssueCandidate,
	type RunFacts,
	selectTracker,
	TRACKER_AUTHOR,
	TRACKER_LABEL,
	TRACKER_MARKER,
	TRIAGE_LABEL,
} from "./deploy-tracker.ts";

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
	workflow: "Deploy",
	runUrl: "https://example.invalid/runs/1",
	headSha: "0cb9588f210bc4a6eed429d32d9f2d262406d8b5",
	branch: "main",
	failedJobs: ["deploy (web)"],
	jobsRead: true,
	mention: "the-founder",
	...over,
});

const tracker = (over: Partial<IssueCandidate> = {}): IssueCandidate => ({
	number: 100,
	body: `${TRACKER_MARKER}\nstill red`,
	authorLogin: TRACKER_AUTHOR,
	authorType: "Bot",
	...over,
});

describe("selectTracker — the marker decides, and only the bot's own issue counts", () => {
	it("picks the bot-authored issue carrying the marker", () => {
		assert.strictEqual(selectTracker([tracker()])?.number, 100);
	});

	it("ignores an issue with no marker, however it is titled", () => {
		assert.strictEqual(selectTracker([tracker({body: "Deploy is failing on main"})]), null);
	});

	it("ignores a human issue that quotes the marker", () => {
		const quoted = tracker({authorLogin: "a-person", authorType: "User"});
		assert.strictEqual(selectTracker([quoted]), null);
	});

	it("ignores a bot login that is not the CI bot", () => {
		assert.strictEqual(selectTracker([tracker({authorLogin: "dependabot[bot]"})]), null);
	});

	it("picks the lowest number when the board somehow carries two", () => {
		const both = [tracker({number: 400}), tracker({number: 120})];
		assert.strictEqual(selectTracker(both)?.number, 120);
	});

	it("an empty board selects nothing", () => {
		assert.strictEqual(selectTracker([]), null);
	});
});

describe("decide — red opens one tracker, every later red comments on it", () => {
	it("first red with no tracker open → create", () => {
		const decision = decide("failure", facts(), []);
		assert.strictEqual(decision.action, "create");
	});

	it("the created issue carries the tracker label and the triage label", () => {
		const decision = decide("failure", facts(), []);
		assert.strictEqual(decision.action, "create");
		if (decision.action !== "create") return;
		assert.deepStrictEqual([...decision.labels], [TRACKER_LABEL, TRIAGE_LABEL]);
	});

	it("the created body names the failed job, the run, the head sha and the mention", () => {
		const decision = decide("failure", facts(), []);
		assert.strictEqual(decision.action, "create");
		if (decision.action !== "create") return;
		assert.include(decision.body, "`deploy (web)`");
		assert.include(decision.body, "https://example.invalid/runs/1");
		assert.include(decision.body, "0cb9588f210bc4a6eed429d32d9f2d262406d8b5");
		assert.include(decision.body, "@the-founder");
		assert.include(decision.body, TRACKER_MARKER);
	});

	it("the second red comments on the standing tracker rather than opening a second issue", () => {
		const decision = decide("failure", facts(), [tracker()]);
		assert.strictEqual(decision.action, "comment");
		if (decision.action !== "comment") return;
		assert.strictEqual(decision.issue, 100);
		assert.include(decision.body, "Still red");
	});

	it("two consecutive reds are exactly one create and one comment", () => {
		const first = decide("failure", facts(), []);
		assert.strictEqual(first.action, "create");
		const second = decide("failure", facts(), [tracker()]);
		assert.strictEqual(second.action, "comment");
	});

	it("an unreadable job list still files, and says the list was unreadable", () => {
		const decision = decide("failure", facts({failedJobs: [], jobsRead: false}), []);
		assert.strictEqual(decision.action, "create");
		if (decision.action !== "create") return;
		assert.include(decision.body, "could not be read");
	});

	it("a read job list with no failed job says so rather than claiming one", () => {
		const decision = decide("failure", facts({failedJobs: []}), []);
		assert.strictEqual(decision.action, "create");
		if (decision.action !== "create") return;
		assert.include(decision.body, "none of the run's jobs reported a `failure` conclusion");
	});

	it("several failed jobs are all named", () => {
		const decision = decide("failure", facts({failedJobs: ["deploy (web)", "deploy (api)"]}), []);
		assert.strictEqual(decision.action, "create");
		if (decision.action !== "create") return;
		assert.include(decision.body, "`deploy (web)`, `deploy (api)`");
	});

	it("an empty mention omits the mention line instead of writing a bare @", () => {
		const decision = decide("failure", facts({mention: ""}), []);
		assert.strictEqual(decision.action, "create");
		if (decision.action !== "create") return;
		assert.notInclude(decision.body, "@\n");
	});
});

describe("decide — green closes the tracker, and is a no-op when there is none", () => {
	it("green with a tracker open → close, with a comment linking the green run", () => {
		const decision = decide("success", facts({failedJobs: [], jobsRead: true}), [tracker()]);
		assert.strictEqual(decision.action, "close");
		if (decision.action !== "close") return;
		assert.strictEqual(decision.issue, 100);
		assert.include(decision.comment, "https://example.invalid/runs/1");
		assert.include(decision.comment, "Green again");
	});

	it("green with no tracker open → noop (the common case never fails a run)", () => {
		const decision = decide("success", facts(), []);
		assert.strictEqual(decision.action, "noop");
	});

	it("green ignores an open issue that is not this workflow's tracker", () => {
		const decision = decide("success", facts(), [tracker({body: "unrelated"})]);
		assert.strictEqual(decision.action, "noop");
	});
});

describe("factsFromEnv — workflow strings in, run facts out", () => {
	it("reads every fact the workflow supplies", () => {
		const read = factsFromEnv(
			{
				TRACKER_WORKFLOW: "Deploy",
				TRACKER_RUN_URL: "https://example.invalid/runs/2",
				TRACKER_HEAD_SHA: "abcdef1234567890",
				TRACKER_BRANCH: "main",
				TRACKER_MENTION: "@the-founder",
			},
			["deploy (web)"],
			true,
		);
		assert.strictEqual(read.workflow, "Deploy");
		assert.strictEqual(read.runUrl, "https://example.invalid/runs/2");
		assert.strictEqual(read.headSha, "abcdef1234567890");
		assert.strictEqual(read.branch, "main");
		// The `@` belongs to the rendered line, not to the login.
		assert.strictEqual(read.mention, "the-founder");
	});

	it("a blank environment still produces facts rather than throwing", () => {
		const read = factsFromEnv({}, [], false);
		assert.strictEqual(read.workflow, "the workflow");
		assert.strictEqual(read.branch, "main");
		assert.strictEqual(read.mention, "");
		assert.strictEqual(read.jobsRead, false);
	});
});
