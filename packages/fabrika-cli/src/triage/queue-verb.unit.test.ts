import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {ANSWER, FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {ageDays, runQueue, toRows} from "./queue-verb.ts";

const LABELS = /GET .*\/repos\/o\/r\/labels\?/;
const QUEUE = /GET .*\/repos\/o\/r\/issues\?state=open/;

const NOW = new Date("2026-08-03T00:00:00Z");

const options = {
	label: "status:needs-triage",
	limit: 100,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	now: () => NOW,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runQueue({...options, ...overrides}), fakeSeams(script).layer));

const labels = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

const labelsOk = [LABELS, labels("status:needs-triage", "type:bug", "p0")] as const;

const row = (n: number, createdAt: string, title: string) => ({
	number: n,
	created_at: createdAt,
	title,
});

const queued = (...rows: ReadonlyArray<unknown>): HttpReply => ({
	status: 200,
	body: JSON.stringify(rows),
});

const BAD_GATEWAY: HttpReply = {status: 502, body: "{}"};

describe("ageDays", () => {
	it("floors to whole days", () => {
		expect(ageDays("2026-08-01T23:00:00Z", NOW)).toBe(1);
		expect(ageDays("2026-08-02T23:59:59Z", NOW)).toBe(0);
	});

	it("reads a clock skew that runs the age negative as 0, never as a negative age", () => {
		expect(ageDays("2026-08-10T00:00:00Z", NOW)).toBe(0);
	});
});

describe("toRows", () => {
	const issues = [
		{number: 3, createdAt: "2026-07-30T00:00:00Z", title: "newest"},
		{number: 1, createdAt: "2026-07-01T00:00:00Z", title: "oldest"},
		{number: 2, createdAt: "2026-07-15T00:00:00Z", title: "middle"},
	];

	it("orders OLDEST first — the claimable end of the queue", () => {
		expect(toRows(issues, NOW, 100).map((r) => r.number)).toEqual([1, 2, 3]);
	});

	it("breaks a tie on the issue number, so the order is total and stable", () => {
		const tied = [
			{number: 9, createdAt: "2026-07-01T00:00:00Z", title: "b"},
			{number: 4, createdAt: "2026-07-01T00:00:00Z", title: "a"},
		];
		expect(toRows(tied, NOW, 100).map((r) => r.number)).toEqual([4, 9]);
	});

	it("caps at the limit AFTER ordering, so the cap keeps the oldest", () => {
		expect(toRows(issues, NOW, 2).map((r) => r.number)).toEqual([1, 2]);
	});

	it("does not mutate its input", () => {
		const input = [...issues];
		toRows(input, NOW, 100);
		expect(input.map((i) => i.number)).toEqual([3, 1, 2]);
	});
});

describe("runQueue", () => {
	it("prints `queued` then one `<number>\\t<age-days>\\t<title>` line per issue", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, queued(row(4312, "2026-08-01T00:00:00Z", "Abort reason lost"))],
		]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("queued\n4312\t2\tAbort reason lost\n");
	});

	it("prints the STATE WORD `empty` — never empty stdout, which a sweep cannot read", async () => {
		const out = await run([labelsOk, [QUEUE, queued()]]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("empty\n");
	});

	it("reports the scanned count on stderr", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, queued(row(1, "2026-08-01T00:00:00Z", "a"), row(2, "2026-08-01T00:00:00Z", "b"))],
		]);
		expect(out.stderr.join("\n")).toContain("scanned 2 open status:needs-triage issues in o/r");
	});

	it("says on stderr when --limit truncated the list", async () => {
		const rows = Array.from({length: 4}, (_, i) => row(i + 1, "2026-08-01T00:00:00Z", "t"));
		const out = await run([labelsOk, [QUEUE, queued(...rows)]], {limit: 2});
		expect(out.stdout.trimEnd().split("\n")).toHaveLength(3);
		expect(out.stderr.join("\n")).toContain("TRUNCATED");
	});

	it("REFUSES a --label that does not exist rather than reporting the queue drained", async () => {
		const out = await run([[LABELS, labels("type:bug", "p0")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});

	it("never reads the queue once the label is proven absent", async () => {
		const seams = fakeSeams([[LABELS, labels("type:bug")]]);
		await Effect.runPromise(Effect.provide(runQueue(options), seams.layer));
		expect(seams.requests.some((c) => QUEUE.test(c))).toBe(false);
	});

	it("refuses an UNREADABLE label set as UNKNOWN — never as `the label is missing`", async () => {
		const out = await run([[LABELS, BAD_GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unreadable queue as UNKNOWN — never `empty`, which terminates a sweep", async () => {
		const out = await run([labelsOk, [QUEUE, BAD_GATEWAY]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "empty"');
	});

	it("prints NO scanned count beside a failed read — a count is a measurement", async () => {
		const out = await run([labelsOk, [QUEUE, BAD_GATEWAY]]);
		expect(out.stderr.join("\n")).not.toContain("scanned");
	});

	it("refuses a GitHub 200 carrying bytes that are not queue rows", async () => {
		const out = await run([labelsOk, [QUEUE, queued("not a row")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("pages the queue read — an unpaginated read truncates at GitHub's default page", async () => {
		const seams = fakeSeams([labelsOk, [QUEUE, queued()]]);
		await Effect.runPromise(Effect.provide(runQueue(options), seams.layer));
		expect(seams.requests.find((c) => QUEUE.test(c))).toContain("per_page=100");
	});

	it("puts the --json payload on stdout, carrying the outcome word and the scanned count", async () => {
		const out = await run([labelsOk, [QUEUE, queued(row(4312, "2026-08-01T00:00:00Z", "t"))]], {
			json: true,
		});
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "queued",
			issues: [{number: 4312, ageDays: 2, title: "t"}],
			scanned: 1,
			truncated: false,
		});
	});

	it("carries the `empty` outcome word into the --json payload too", async () => {
		const out = await run([labelsOk, [QUEUE, queued()]], {json: true});
		expect(JSON.parse(out.stdout).outcome).toBe("empty");
	});

	it("refuses a --limit below 1 as a usage error", async () => {
		const out = await run([labelsOk], {limit: 0});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
	});

	it("refuses when no target repo resolves", async () => {
		const out = await run([[/git remote get-url/, errOut("no origin")]], {env: {}});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("CLAUDE_PIPELINE_REPO");
	});
});
