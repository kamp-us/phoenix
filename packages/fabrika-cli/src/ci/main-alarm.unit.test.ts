import {assert, describe, it} from "@effect/vitest";
import {
	ACTIONS_BOT,
	alarmMarker,
	decide,
	decodeResult,
	factsFromEnv,
	type IssueCandidate,
	type RunFacts,
	type RunInput,
	selectAlarm,
	TRIAGE_LABEL,
	workflowKeyFromEnv,
} from "./main-alarm.ts";

const LABEL = "fabrika-main-alarm";
const KEY = "deploy.yml";
const MARKER = alarmMarker(KEY);

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
	workflow: "Deploy",
	workflowKey: KEY,
	runUrl: "https://example.invalid/runs/1",
	headSha: "0cb9588f210bc4a6eed429d32d9f2d262406d8b5",
	branch: "main",
	failedJobs: ["deploy (web)"],
	jobsRead: true,
	mention: ["@the-founder"],
	...over,
});

const input = (over: Partial<RunInput> = {}): RunInput => ({
	event: "push",
	result: "failure",
	label: LABEL,
	facts: facts(),
	...over,
});

const alarm = (over: Partial<IssueCandidate> = {}): IssueCandidate => ({
	number: 100,
	body: `${MARKER}\nstill red`,
	authorLogin: ACTIONS_BOT,
	authorType: "Bot",
	...over,
});

describe("selectAlarm — the marker decides, and only the bot's own issue counts", () => {
	it("picks the bot-authored issue carrying this workflow's marker", () => {
		assert.strictEqual(selectAlarm(MARKER, [alarm()])?.number, 100);
	});

	it("ignores an issue with no marker, however it is titled", () => {
		assert.strictEqual(selectAlarm(MARKER, [alarm({body: "Deploy is failing on main"})]), null);
	});

	it("ignores a human issue that quotes the marker", () => {
		const quoted = alarm({authorLogin: "a-person", authorType: "User"});
		assert.strictEqual(selectAlarm(MARKER, [quoted]), null);
	});

	it("ignores a different bot carrying the marker", () => {
		assert.strictEqual(selectAlarm(MARKER, [alarm({authorLogin: "dependabot[bot]"})]), null);
	});

	it("ignores an issue with a null body", () => {
		assert.strictEqual(selectAlarm(MARKER, [alarm({body: null})]), null);
	});

	it("takes the lowest number when the board somehow carries two", () => {
		assert.strictEqual(
			selectAlarm(MARKER, [alarm({number: 300}), alarm({number: 120})])?.number,
			120,
		);
	});

	it("does not see another workflow's alarm", () => {
		const other = alarm({body: `${alarmMarker("release-please.yml")}\nstill red`});
		assert.strictEqual(selectAlarm(MARKER, [other]), null);
	});
});

describe("decide — the five cases the alarm exists for", () => {
	it("first red with no alarm open creates one, carrying both labels", () => {
		const decision = decide(input(), []);
		assert.strictEqual(decision.action, "create");
		if (decision.action !== "create") return;
		assert.deepStrictEqual([...decision.labels], [LABEL, TRIAGE_LABEL]);
		assert.include(decision.body, MARKER);
		assert.include(decision.body, "deploy (web)");
		assert.include(decision.body, "https://example.invalid/runs/1");
		assert.include(decision.body, "0cb9588f");
		assert.include(decision.title, "Deploy");
	});

	it("a further red comments on the alarm already open, never opening a second", () => {
		const decision = decide(input(), [alarm()]);
		assert.strictEqual(decision.action, "comment");
		if (decision.action !== "comment") return;
		assert.strictEqual(decision.issue, 100);
		assert.include(decision.body, "Still red");
	});

	it("green with an alarm open closes it, with a link to the green run", () => {
		const decision = decide(input({result: "success"}), [alarm()]);
		assert.strictEqual(decision.action, "close");
		if (decision.action !== "close") return;
		assert.strictEqual(decision.issue, 100);
		assert.include(decision.comment, "https://example.invalid/runs/1");
	});

	it("green with no alarm open does nothing", () => {
		assert.strictEqual(decide(input({result: "success"}), []).action, "noop");
	});

	it("a pull_request run never fires, whatever its result or the board", () => {
		assert.strictEqual(decide(input({event: "pull_request"}), []).action, "noop");
		assert.strictEqual(decide(input({event: "pull_request"}), [alarm()]).action, "noop");
		assert.strictEqual(
			decide(input({event: "pull_request", result: "success"}), [alarm()]).action,
			"noop",
		);
	});
});

describe("decide — a run that concluded neither way decides nothing", () => {
	it("leaves a standing alarm open on a cancelled run", () => {
		assert.strictEqual(decide(input({result: "cancelled"}), [alarm()]).action, "noop");
	});

	it("leaves a standing alarm open on a skipped run", () => {
		assert.strictEqual(decide(input({result: "skipped"}), [alarm()]).action, "noop");
	});
});

describe("decide — two consecutive reds are exactly one create and one comment", () => {
	it("opens on the first and comments on the second", () => {
		const first = decide(input(), []);
		assert.strictEqual(first.action, "create");
		const second = decide(input(), [alarm()]);
		assert.strictEqual(second.action, "comment");
	});
});

describe("the body says what it knows, and never more", () => {
	it("says the job list was unreadable rather than claiming no job failed", () => {
		const decision = decide(input({facts: facts({failedJobs: [], jobsRead: false})}), []);
		if (decision.action !== "create") return assert.fail("expected a create");
		assert.include(decision.body, "could not be read");
	});

	it("says the run failed outside a job when the list read empty", () => {
		const decision = decide(input({facts: facts({failedJobs: [], jobsRead: true})}), []);
		if (decision.action !== "create") return assert.fail("expected a create");
		assert.include(decision.body, "failed outside a job");
	});

	it("writes one @handle per declared mention, never a doubled @", () => {
		const decision = decide(input({facts: facts({mention: ["@one", "two"]})}), []);
		if (decision.action !== "create") return assert.fail("expected a create");
		assert.include(decision.body, "@one @two");
		assert.notInclude(decision.body, "@@");
	});

	it("omits the mention line entirely when nobody is declared", () => {
		const decision = decide(input({facts: facts({mention: []})}), []);
		if (decision.action !== "create") return assert.fail("expected a create");
		assert.notInclude(decision.body, "@");
	});
});

describe("decodeResult — a value Actions never emits is refused, never defaulted", () => {
	it("takes the four Actions results", () => {
		assert.strictEqual(decodeResult("success"), "success");
		assert.strictEqual(decodeResult("failure"), "failure");
		assert.strictEqual(decodeResult("cancelled"), "cancelled");
		assert.strictEqual(decodeResult(" skipped "), "skipped");
	});

	it("refuses a misspelling rather than reading it as either polarity", () => {
		assert.strictEqual(decodeResult("faliure"), null);
		assert.strictEqual(decodeResult(""), null);
		assert.strictEqual(decodeResult("Success"), null);
	});
});

describe("workflowKeyFromEnv — the key survives a display-name rename", () => {
	it("takes the workflow file out of GITHUB_WORKFLOW_REF", () => {
		assert.strictEqual(
			workflowKeyFromEnv({
				GITHUB_WORKFLOW_REF: "o/r/.github/workflows/deploy.yml@refs/heads/main",
				GITHUB_WORKFLOW: "Deploy",
			}),
			"deploy.yml",
		);
	});

	it("keeps two workflows apart", () => {
		const key = (file: string) =>
			workflowKeyFromEnv({GITHUB_WORKFLOW_REF: `o/r/.github/workflows/${file}@refs/heads/main`});
		assert.notStrictEqual(key("deploy.yml"), key("release-please.yml"));
	});

	it("falls back to a slug of the display name when the ref is absent", () => {
		assert.strictEqual(workflowKeyFromEnv({GITHUB_WORKFLOW: "Release Please"}), "release-please");
	});

	it("never yields an empty key", () => {
		assert.strictEqual(workflowKeyFromEnv({}), "unnamed-workflow");
	});
});

describe("factsFromEnv — a blank environment still speaks", () => {
	it("fills the two prose fields rather than rendering empty backticks", () => {
		const blank = factsFromEnv({}, [], [], false);
		assert.strictEqual(blank.workflow, "the workflow");
		assert.strictEqual(blank.branch, "the default branch");
	});

	it("builds the run URL out of the platform's own three variables", () => {
		const read = factsFromEnv(
			{
				GITHUB_SERVER_URL: "https://example.invalid",
				GITHUB_REPOSITORY: "o/r",
				GITHUB_RUN_ID: "42",
				GITHUB_SHA: "abc",
				GITHUB_REF_NAME: "main",
			},
			["@someone"],
			[],
			true,
		);
		assert.strictEqual(read.runUrl, "https://example.invalid/o/r/actions/runs/42");
		assert.strictEqual(read.headSha, "abc");
		assert.deepStrictEqual([...read.mention], ["@someone"]);
	});
});
