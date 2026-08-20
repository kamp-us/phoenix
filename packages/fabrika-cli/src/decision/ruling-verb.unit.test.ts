import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {emit, markedIssue, rulingUrl, scopeDigest} from "../wire/decision-ruling.ts";
import {markerTime} from "../wire/grill-marker.ts";
import {bodyDigest} from "./digest.ts";
import {
	acl,
	BODY,
	COMMENTS,
	comments,
	env,
	ISSUE,
	ISSUE_READ,
	issueRead,
	MEMBERS,
	RULER,
	RULING_URL,
} from "./fixtures.test-support.ts";
import {runRuling} from "./ruling-verb.ts";

type Script = ReadonlyArray<readonly [RegExp, ExecResult]>;

const run = (script: Script) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(runRuling({number: ISSUE, repo: null, env}), shell.layer),
	).then((outcome) => JSON.parse(outcome.stdout === "" ? "null" : outcome.stdout) ?? outcome);
};

const outcomeOf = (script: Script) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(runRuling({number: ISSUE, repo: null, env}), shell.layer),
	);
};

/** A marker over `digest`, as `decision rule` would have posted it. */
const marker = (digest: string): string =>
	emit({
		issue: markedIssue(ISSUE) ?? (0 as never),
		digest: scopeDigest(digest) ?? ("" as never),
		ruling: rulingUrl(RULING_URL) ?? ("" as never),
		at: markerTime("2026-08-20T05:11:02Z") ?? ("" as never),
	});

describe("runRuling", () => {
	it("reports current for a roster-authored marker over the body as it now stands", async () => {
		const answer = await run([
			[ISSUE_READ, issueRead(["type:decision", "ready-for:agent"])],
			[COMMENTS, comments([900002, RULER, marker(bodyDigest(BODY))])],
			...acl,
		]);
		expect(answer).toMatchObject({
			answer: "ruling",
			issue: ISSUE,
			state: "current",
			by: RULER,
			markerDigest: bodyDigest(BODY),
			derivedDigest: bodyDigest(BODY),
			ruling: RULING_URL,
			audience: "ready-for:agent",
			disregarded: 0,
			unauthorized: 0,
		});
	});

	/**
	 * The staleness property, end to end: the marker still stands and still binds a digest, and the
	 * body it bound has been rewritten under it, so the ruling no longer rates current.
	 */
	it("reports stale once the body the ruling bound is rewritten", async () => {
		const answer = await run([
			[ISSUE_READ, issueRead(["type:decision", "ready-for:agent"], `${BODY}\nRe-scoped.\n`)],
			[COMMENTS, comments([900002, RULER, marker(bodyDigest(BODY))])],
			...acl,
		]);
		expect(answer).toMatchObject({
			state: "stale",
			markerDigest: bodyDigest(BODY),
			derivedDigest: bodyDigest(`${BODY}\nRe-scoped.\n`),
		});
		expect(answer.markerDigest).not.toBe(answer.derivedDigest);
	});

	it("reports absent, at exit 0, when nobody has ruled", async () => {
		const outcome = await outcomeOf([
			[ISSUE_READ, issueRead()],
			[COMMENTS, comments([900002, RULER, "Still thinking about the second fork.\n"])],
			...acl,
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			state: "absent",
			by: null,
			comment: null,
			audience: "ready-for:human",
		});
	});

	it("counts an off-roster marker unauthorized, and never lets it stand", async () => {
		const answer = await run([
			[ISSUE_READ, issueRead()],
			[COMMENTS, comments([900002, "drive-by", marker(bodyDigest(BODY))])],
			...acl,
		]);
		expect(answer).toMatchObject({state: "absent", unauthorized: 1, disregarded: 0});
	});

	it("counts a drifted marker disregarded rather than dropping it", async () => {
		const answer = await run([
			[ISSUE_READ, issueRead()],
			[COMMENTS, comments([900002, RULER, "decision-ruled: #4300 @ NOTHEX · last Thursday\n"])],
			...acl,
		]);
		expect(answer).toMatchObject({state: "absent", disregarded: 1});
	});

	it("takes the newest marker when a decision has been re-ruled", async () => {
		const answer = await run([
			[ISSUE_READ, issueRead()],
			[
				COMMENTS,
				comments(
					[900002, RULER, marker("aaaaaaaaaaaa")],
					[900003, RULER, marker(bodyDigest(BODY))],
				),
			],
			...acl,
		]);
		expect(answer).toMatchObject({state: "current", comment: 900003});
	});

	it("is UNKNOWN, never absent, when the roster cannot be read", async () => {
		const outcome = await outcomeOf([
			[MEMBERS, errOut("gh: Bad gateway (HTTP 502)")],
			[ISSUE_READ, issueRead()],
			[COMMENTS, comments([900002, RULER, marker(bodyDigest(BODY))])],
			...acl,
		]);
		expect(outcome.code).toBe(11);
		expect(outcome.stdout).toBe("");
	});

	it("is UNKNOWN, never absent, when the comments cannot be read", async () => {
		const outcome = await outcomeOf([
			[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
			[ISSUE_READ, issueRead()],
			...acl,
		]);
		expect(outcome.code).toBe(11);
		expect(outcome.stdout).toBe("");
	});

	it("refuses an issue that is not a type:decision", async () => {
		const outcome = await outcomeOf([
			[ISSUE_READ, issueRead(["type:feature", "ready-for:agent"])],
			...acl,
		]);
		expect(outcome.code).toBe(7);
	});

	it("splits an unreadable issue from a proven absent one", async () => {
		const unreadable = await outcomeOf([[ISSUE_READ, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(unreadable.code).toBe(11);
		const gone = await outcomeOf([[ISSUE_READ, errOut("gh: Not Found (HTTP 404)")]]);
		expect(gone.code).toBe(7);
	});

	it("reads a marker quoted on another issue as ruling nothing here", async () => {
		const elsewhere = emit({
			issue: markedIssue(5842) ?? (0 as never),
			digest: scopeDigest(bodyDigest(BODY)) ?? ("" as never),
			ruling: rulingUrl("https://github.com/o/r/issues/5842#issuecomment-900001") ?? ("" as never),
			at: markerTime("2026-08-20T05:11:02Z") ?? ("" as never),
		});
		const answer = await run([
			[ISSUE_READ, issueRead()],
			[COMMENTS, comments([900002, RULER, elsewhere])],
			...acl,
		]);
		expect(answer).toMatchObject({state: "absent", disregarded: 0, unauthorized: 0});
	});

	it("reports no audience label as null rather than guessing one", async () => {
		const answer = await run([
			[ISSUE_READ, issueRead(["type:decision"])],
			[COMMENTS, okOut("[]")],
			...acl,
		]);
		expect(answer).toMatchObject({audience: null, state: "absent"});
	});
});
