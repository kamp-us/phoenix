import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import * as graduateEmitted from "../wire/graduate-emitted.ts";
import {markerTime} from "../wire/grill-marker.ts";
import {NO_TARGET, PRECONDITION_UNKNOWN, SOURCE_UNRECOGNIZED} from "./codes.ts";
import {commentsPayload, issueJson, REPO, SESSION} from "./fixtures.test-support.ts";
import {runRead} from "./read-verb.ts";

const ISSUE = /^GET .*\/repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/9412\/comments\?/;

/** A served 200 — every read below asks for JSON and gets a whole single page. */
const served = (body: string): HttpReply => ({status: 200, body});

const AT = markerTime("2026-08-09T18:36:48Z");
if (AT === null) throw new Error("the fixture stamp did not build");

const marker = (digest: string, emitted: number, covers: [string, ...string[]]): string =>
	graduateEmitted.emit({
		source: SESSION,
		emitted,
		digest:
			graduateEmitted.specDigest(digest) ??
			(() => {
				throw new Error("the fixture digest did not build");
			})(),
		covers,
		at: AT,
	});

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(
		Effect.provide(
			runRead({source: SESSION, repo: null, env: {CLAUDE_PIPELINE_REPO: REPO}}),
			fakeSeams(script).layer,
		),
	);

const source = [ISSUE, served(issueJson({number: SESSION, labels: ["grilling:session"]}))] as const;

describe("the read is total and three-valued", () => {
	it("reads a source with no comments as ungraduated — zero comments is a FACT", async () => {
		const out = await run([source, [COMMENTS, served("[]")]]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			source: SESSION,
			state: "ungraduated",
			emissions: [],
			disregarded: [],
			scanned: {comments: 0},
		});
	});

	it("reports every parsed emission, oldest first, with its covers list", async () => {
		const out = await run([
			source,
			[
				COMMENTS,
				served(
					commentsPayload([
						{id: 5, author: "acme-founder", body: marker("a1b2c3d4e5f6", 9520, ["R1.1", "R1.2"])},
						{id: 6, author: "acme-founder", body: marker("0123456789ab", 9530, ["#9301 R1.4"])},
					]),
				),
			],
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.state).toBe("graduated");
		expect(answer.emissions).toEqual([
			{
				issue: 9520,
				specDigest: "a1b2c3d4e5f6",
				covers: ["R1.1", "R1.2"],
				emittedAt: "2026-08-09T18:36:48Z",
				comment: 5,
			},
			{
				issue: 9530,
				specDigest: "0123456789ab",
				covers: ["#9301 R1.4"],
				emittedAt: "2026-08-09T18:36:48Z",
				comment: 6,
			},
		]);
	});

	it("never refuses on marker content — a malformed marker is a disregarded row at exit 0", async () => {
		const out = await run([
			source,
			[
				COMMENTS,
				served(
					commentsPayload([
						{
							id: 9,
							author: "acme-founder",
							body: "graduate-emitted: #9412 → #9520 @ NOTHEX · covers R1.1 · 2026-08-09T18:36:48Z\n",
						},
					]),
				),
			],
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.state).toBe("ungraduated");
		expect(answer.disregarded).toMatchObject([{comment: 9, reason: "malformed"}]);
	});

	it("ignores an ordinary comment rather than reporting it as a drift", async () => {
		const out = await run([
			source,
			[
				COMMENTS,
				served(commentsPayload([{id: 3, author: "acme-founder", body: "picking this up"}])),
			],
		]);
		expect(JSON.parse(out.stdout).disregarded).toEqual([]);
	});
});

describe("its only three refusals", () => {
	it("refuses a source that does not exist", async () => {
		const out = await run([[ISSUE, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
	});

	it("refuses a source carrying neither label, in this verb's own words", async () => {
		const out = await run([[ISSUE, served(issueJson({number: SESSION, labels: []}))]]);
		expect(out.code).toBe(SOURCE_UNRECOGNIZED);
		expect(out.stderr.join("\n")).toContain(
			`graduate read: #${SESSION} carries neither grilling:session nor wayfinding:map.`,
		);
	});

	it('refuses a comment read that could not complete — never "no"', async () => {
		const out = await run([source, [COMMENTS, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain('UNKNOWN, never "no"');
	});
});
