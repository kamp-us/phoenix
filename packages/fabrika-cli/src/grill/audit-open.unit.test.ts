import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import * as audit from "../wire/audit-context.ts";
import {AUDIT_FIELDS} from "../wire/audit-context-fixture.ts";
import {type AuditAttempt, runAuditOpen} from "./audit-open.ts";
import {sessionPayload} from "./fixtures.test-support.ts";

const ALL = /^GET .*\/repos\/o\/r\/issues\?state=all/;
const ISSUE = /^GET .*\/repos\/o\/r\/issues\/\d+$/;
const CREATE = /^POST .*\/repos\/o\/r\/issues$/;
const LABELS = /^GET .*\/repos\/o\/r\/labels\?/;
const LABEL_WRITE = /^POST .*\/repos\/o\/r\/issues\/\d+\/labels$/;
const served = (value: unknown, status = 200): HttpReply => ({status, body: JSON.stringify(value)});
const parsed = audit.parse(AUDIT_FIELDS);
if (parsed._tag !== "Found") throw new Error("invalid fixture");
const context = parsed.value;
const body = audit.emit(context);
const row = (number = 51, overrides: Record<string, unknown> = {}) => ({
	...JSON.parse(sessionPayload(number, {body})),
	...overrides,
});
const listing = (...rows: ReadonlyArray<unknown>) => served(rows);
const labels: Scripted = [LABELS, served([{name: "grilling:session"}])];
const run = async (
	script: ReadonlyArray<Scripted>,
	text = AUDIT_FIELDS,
	attempt: AuditAttempt = {_tag: "Create"},
) => {
	const io = fakeSeams(script);
	const out = await Effect.runPromise(
		runAuditOpen({text, attempt, repo: "o/r", env: {}}).pipe(Effect.provide(io.layer)),
	);
	return {out, io};
};

describe("initial audit handoff", () => {
	it("sends all research in the initial POST and checks the recovered label", async () => {
		const {out, io} = await run([
			[ALL, listing()],
			labels,
			[CREATE, served({number: 51, html_url: "https://example.test/issues/51"}, 201)],
			[once(ISSUE), served(row(51, {labels: []}))],
			[ISSUE, served(row())],
			[LABEL_WRITE, served({})],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			session: 51,
			created: true,
			runId: context.runId,
			digest: audit.digest(context),
		});
		const sent = JSON.parse(
			io.bodies[io.requests.findIndex((request) => CREATE.test(request))] ?? "{}",
		);
		expect(audit.read(sent.body)).toEqual({_tag: "Found", value: context});
		expect(io.requests.filter((request) => LABEL_WRITE.test(request))).toHaveLength(1);
	});
	it("same context resumes after a title change", async () => {
		const renamed = row(51, {title: "Something else"});
		const {out, io} = await run([
			[ALL, listing(renamed)],
			[ISSUE, served(renamed)],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).created).toBe(false);
		expect(io.requests.some((request) => request.startsWith("POST"))).toBe(false);
	});
	it("a deliberate rerun retains its predecessor and creates a fresh session", async () => {
		const next = {...context, runId: "audit-second-run", predecessor: 51};
		const emitted = audit.emitFromFields(JSON.stringify(next));
		if (emitted._tag !== "Composed") throw new Error(emitted.reason);
		const {out, io} = await run(
			[
				[ALL, listing(row())],
				labels,
				[/GET .*\/issues\/51$/, served(row())],
				[CREATE, served({number: 52, html_url: "https://example.test/issues/52"}, 201)],
				[/GET .*\/issues\/52$/, served(row(52, {body: emitted.bytes}))],
			],
			JSON.stringify(next),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).session).toBe(52);
		expect(io.requests.filter((request) => CREATE.test(request))).toHaveLength(1);
	});
	it.each([
		["closed", row(51, {state: "closed"}), 23],
		[
			"changed context",
			row(51, {body: body.replace("wrong action repeats", "no longer repeats")}),
			22,
		],
		["malformed context", row(51, {body: "## Audit Context\nmissing"}), 20],
	] as const)("refuses %s without creating or overwriting", async (_name, existing, code) => {
		const {out, io} = await run([
			[ALL, listing(existing)],
			[ISSUE, served(existing)],
		]);
		expect(out.code).toBe(code);
		expect(
			io.requests.some((request) => request.startsWith("POST") || request.startsWith("PATCH")),
		).toBe(false);
	});
	it("reports all duplicate identities", async () => {
		const {out} = await run([[ALL, listing(row(), row(52))]]);
		expect(out.code).toBe(16);
		expect(out.stderr.join("\n")).toContain("session=52");
	});
	it.each([
		"{",
		JSON.stringify({...context, ruling: "approved"}),
		JSON.stringify({...context, findings: []}),
	])("refuses malformed input before I/O", async (input) => {
		const {out, io} = await run([], input);
		expect(out.code).toBe(20);
		expect(io.requests).toHaveLength(0);
	});
	it("refuses an oversized final body before I/O", async () => {
		const {out, io} = await run(
			[],
			JSON.stringify({
				...context,
				accounting: {...context.accounting, limits: ["x".repeat(60_000)]},
			}),
		);
		expect(out.code).toBe(21);
		expect(io.requests).toHaveLength(0);
	});
	it("refuses leaks before I/O", async () => {
		const {out, io} = await run(
			[],
			AUDIT_FIELDS.replace("src/capture.ts:42", "/Users/alice/private/capture.ts:42"),
		);
		expect(out.code).toBe(5);
		expect(io.requests).toHaveLength(0);
	});
	it("refuses an incomplete all-issue response", async () => {
		const {out, io} = await run([[ALL, listing({number: 51, title: "partial"})]]);
		expect(out.code).toBe(11);
		expect(io.requests.some((request) => CREATE.test(request))).toBe(false);
	});
});

describe("audit recovery", () => {
	it("walks beyond the ordinary 50-page cap and retains a later match", async () => {
		let page = 0;
		const response: HttpReply = {
			status: 200,
			get body() {
				page++;
				return JSON.stringify(page === 51 ? [row()] : []);
			},
			get headers() {
				return page < 51
					? {link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"'}
					: {};
			},
		};
		const {out, io} = await run(
			[
				[ALL, response],
				[ISSUE, served(row())],
			],
			AUDIT_FIELDS,
			{_tag: "Recover", session: null},
		);
		expect(out.code).toBe(0);
		expect(io.requests.filter((request) => ALL.test(request))).toHaveLength(51);
	});
	it("an interrupted later page never permits creation", async () => {
		const first: HttpReply = {
			status: 200,
			body: "[]",
			headers: {link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"'},
		};
		const {out, io} = await run([
			[once(ALL), first],
			[ALL, served({}, 502)],
		]);
		expect(out.code).toBe(11);
		expect(io.requests.some((request) => CREATE.test(request))).toBe(false);
	});
	it("a null body on an unrelated ordinary issue does not block a matching audit", async () => {
		const {out} = await run([
			[ALL, listing(row(50, {body: null}), row())],
			[ISSUE, served(row())],
		]);
		expect(out.code).toBe(0);
	});
	it("reads a known unlabelled partial create directly", async () => {
		const {out, io} = await run(
			[
				[once(ISSUE), served(row(51, {labels: []}))],
				[ISSUE, served(row())],
				[LABEL_WRITE, served({})],
			],
			AUDIT_FIELDS,
			{_tag: "Recover", session: 51},
		);
		expect(out.code).toBe(0);
		expect(io.requests.some((request) => ALL.test(request) || CREATE.test(request))).toBe(false);
	});
	it("retains the known issue after a body readback failure", async () => {
		const {out, io} = await run([
			[ALL, listing()],
			labels,
			[CREATE, served({number: 51, html_url: "https://example.test/issues/51"}, 201)],
			[ISSUE, served({}, 502)],
		]);
		expect(out.code).toBe(9);
		expect(out.stderr.join("\n")).toContain("session=51 url=https://example.test/issues/51");
		expect(io.requests.filter((request) => CREATE.test(request))).toHaveLength(1);
	});
	it("examines the known issue even after the label write failed", async () => {
		const {out, io} = await run(
			[
				[ISSUE, served(row(51, {labels: []}))],
				[LABEL_WRITE, served({}, 502)],
			],
			AUDIT_FIELDS,
			{_tag: "Recover", session: 51},
		);
		expect(out.code).toBe(8);
		expect(io.requests.filter((request) => ISSUE.test(request))).toHaveLength(2);
		expect(out.stderr.join("\n")).toContain("session=51");
	});
	it("recovers a lost create response through identity across all issues", async () => {
		const {out} = await run([
			[once(ALL), listing()],
			[once(ALL), listing()],
			[ALL, listing(row())],
			labels,
			[CREATE, served({}, 502)],
			[ISSUE, served(row())],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).session).toBe(51);
	});
	it("a missing identity during recovery remains UNKNOWN and cannot create", async () => {
		const {out, io} = await run([[ALL, listing()]], AUDIT_FIELDS, {_tag: "Recover", session: null});
		expect(out.code).toBe(8);
		expect(io.requests.some((request) => CREATE.test(request))).toBe(false);
	});
	it("a failed identity read remains UNKNOWN and cannot create", async () => {
		const {out, io} = await run([[ALL, served({}, 502)]]);
		expect(out.code).toBe(11);
		expect(io.requests.some((request) => CREATE.test(request))).toBe(false);
	});
	it("observes another create between the first and second enumeration", async () => {
		const {out, io} = await run([
			[once(ALL), listing()],
			[ALL, listing(row())],
			labels,
			[ISSUE, served(row())],
		]);
		expect(out.code).toBe(0);
		expect(io.requests.some((request) => CREATE.test(request))).toBe(false);
	});
	it("two first attempts can interleave after their reads; subsequent recovery refuses the twins", async () => {
		const attempts = await Promise.all(
			[51, 52].map((number) =>
				run([
					[ALL, listing()],
					labels,
					[CREATE, served({number, html_url: `https://example.test/issues/${number}`}, 201)],
					[ISSUE, served(row(number))],
				]),
			),
		);
		expect(attempts.map(({out}) => out.code)).toEqual([0, 0]);
		const recovery = await run([[ALL, listing(row(), row(52))]], AUDIT_FIELDS, {
			_tag: "Recover",
			session: null,
		});
		expect(recovery.out.code).toBe(16);
	});
});
