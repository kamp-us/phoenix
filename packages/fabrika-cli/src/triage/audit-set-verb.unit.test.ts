import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {ANSWER, FAILED} from "../verb.ts";
import {parseAuditSet} from "./audit.ts";
import {runAuditSet} from "./audit-set-verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

const LABELS = /GET .*\/repos\/o\/r\/labels\?/;
const ISSUES = /GET .*\/repos\/o\/r\/issues\?state=open/;

const options = {
	label: "audit-me",
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runAuditSet({...options, ...overrides}), fakeSeams(script).layer),
	);

const reply = (body: unknown): HttpReply => ({status: 200, body: JSON.stringify(body)});
const labelsOk = [LABELS, reply([{name: "audit-me"}, {name: "p2"}])] as const;
const row = (number: number, title: string) => ({
	number,
	title,
	created_at: "2026-08-01T00:00:00Z",
});

describe("runAuditSet", () => {
	it("prints `set` then every issue ascending by number", async () => {
		const out = await run([labelsOk, [ISSUES, reply([row(9, "nine"), row(4, "four")])]]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("set\n4\tfour\n9\tnine\n");
		expect(out.stderr.join("\n")).toContain("scanned 2 open audit-me issues in o/r");
	});

	it("never truncates — the merge checks rows against this whole set", async () => {
		const rows = Array.from({length: 150}, (_, i) => row(i + 1, "t"));
		const out = await run([labelsOk, [ISSUES, reply(rows)]]);
		expect(out.stdout.trimEnd().split("\n")).toHaveLength(151);
	});

	it("prints the state word `empty` over an existing label with no open issues", async () => {
		const out = await run([labelsOk, [ISSUES, reply([])]]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("empty\n");
	});

	it("prints under --json the shape audit-merge --input reads", async () => {
		const out = await run([labelsOk, [ISSUES, reply([row(4, "four")])]], {json: true});
		const printed = JSON.parse(out.stdout) as unknown;
		expect(printed).toEqual({
			outcome: "set",
			label: "audit-me",
			repo: "o/r",
			issues: [{number: 4, title: "four"}],
			scanned: 1,
		});
		expect(parseAuditSet(printed)).toEqual({_tag: "Parsed", value: [{number: 4, title: "four"}]});
	});

	it("REFUSES a label that does not exist rather than printing an empty set", async () => {
		const out = await run([[LABELS, reply([{name: "p2"}])]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("label audit-me does not exist in o/r");
	});

	it("refuses an unreadable label set or issue list as UNKNOWN", async () => {
		const bad: HttpReply = {status: 502, body: "{}"};
		expect((await run([[LABELS, bad]])).code).toBe(PRECONDITION_UNKNOWN);
		const out = await run([labelsOk, [ISSUES, bad]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses a blank --label on 1 — the audit names what it judges", async () => {
		expect((await run([], {label: " "})).code).toBe(FAILED);
	});

	it("makes read calls only — every request it sends is a GET", async () => {
		const seams = fakeSeams([labelsOk, [ISSUES, reply([row(4, "four")])]]);
		await Effect.runPromise(Effect.provide(runAuditSet(options), seams.layer));
		expect(seams.requests.length).toBeGreaterThan(0);
		for (const request of seams.requests) expect(request).toMatch(/^GET /);
	});
});
