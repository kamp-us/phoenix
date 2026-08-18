import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {cameFromSection} from "../came-from.ts";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {NO_TARGET, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	AUTHORIZATION,
	answerComment,
	commentsPayload,
	type FakeComment,
	roundComment,
	roundDigestOf,
	rulingComment,
	sessionPayload,
	supersedeComment,
} from "./fixtures.test-support.ts";
import {runRead} from "./read-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/9412\/comments\?/;
const PERMISSION = /^gh api repos\/o\/r\/collaborators\/([a-z-]+)\/permission/;

const BOUND = roundDigestOf(1);
const ROUND = {id: 1, author: "acme-founder", body: roundComment(1)} satisfies FakeComment;

const options = {
	session: 9412,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

interface ReadAnswer {
	readonly session: number;
	readonly ticket: number | null;
	readonly frontier: string;
	readonly questions: ReadonlyArray<Record<string, unknown>>;
	readonly disregarded: ReadonlyArray<{comment: number; reason: string; detail: string}>;
	readonly counts: Record<string, number>;
	readonly scanned: Record<string, number>;
}

const readSession = async (
	comments: ReadonlyArray<FakeComment>,
	permission: ExecResult = okOut("write"),
): Promise<{code: number; answer: ReadAnswer}> => {
	const out = await Effect.runPromise(
		Effect.provide(
			runRead(options),
			fakeShell([
				[ISSUE, okOut(sessionPayload(9412))],
				[COMMENTS, okOut(commentsPayload(comments))],
				[PERMISSION, permission],
			]).layer,
		),
	);
	return {code: out.code, answer: JSON.parse(out.stdout === "" ? "null" : out.stdout)};
};

describe("the answer names the ticket the session is bound to", () => {
	const readBody = async (body: string) => {
		const out = await Effect.runPromise(
			Effect.provide(
				runRead(options),
				fakeShell([
					[ISSUE, okOut(sessionPayload(9412, {body}))],
					[COMMENTS, okOut(commentsPayload([]))],
				]).layer,
			),
		);
		return JSON.parse(out.stdout) as ReadAnswer;
	};

	it("reports the frontier ticket a bound session carries", async () => {
		expect(await readBody(cameFromSection(5652))).toMatchObject({ticket: 5652});
	});

	it("reports null for a session opened with no ticket", async () => {
		expect(await readBody("A grilling session.\n")).toMatchObject({ticket: null});
	});
});

describe("all four frontier tokens are answers at exit 0", () => {
	it("reads a session with no comments as empty", async () => {
		const {code, answer} = await readSession([]);
		expect(code).toBe(0);
		expect(answer.frontier).toBe("empty");
		expect(answer.questions).toEqual([]);
		expect(answer.scanned).toEqual({comments: 0, rounds: 0, authorsResolved: 0});
	});

	it("reads an un-ruled decision as awaiting-founder", async () => {
		const {code, answer} = await readSession([ROUND]);
		expect(code).toBe(0);
		expect(answer.frontier).toBe("awaiting-founder");
	});

	it("reads a ruled decision with an open fact as facts-pending", async () => {
		const {code, answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: AUTHORIZATION},
			{id: 3, author: "acme-founder", body: rulingComment("R1.2", BOUND)},
		]);
		expect(code).toBe(0);
		expect(answer.frontier).toBe("facts-pending");
	});

	it("reads everything settled as clear", async () => {
		const {code, answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: answerComment("R1.1", BOUND)},
			{id: 3, author: "acme-founder", body: AUTHORIZATION},
			{id: 4, author: "acme-founder", body: rulingComment("R1.2", BOUND)},
		]);
		expect(code).toBe(0);
		expect(answer.frontier).toBe("clear");
		expect(answer.counts).toMatchObject({answered: 1, ruled: 1, open: 0});
	});
});

describe("a ruling resolves only when all four clauses hold", () => {
	it("reports ruled with the proof, author and timestamp when they do", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: AUTHORIZATION},
			{id: 3, author: "acme-founder", body: rulingComment("R1.2", BOUND)},
		]);
		expect(answer.questions[1]).toMatchObject({
			id: "R1.2",
			state: "ruled",
			proof: "acl+authorization",
			author: "acme-founder",
			ruledAt: "2026-08-09T18:36:48Z",
		});
	});

	it("resolves clause 3 to stale, carrying both digests and landing NO disregarded row", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: AUTHORIZATION},
			{id: 3, author: "acme-founder", body: rulingComment("R1.2", "0123456789ab")},
		]);
		expect(answer.questions[1]).toMatchObject({
			state: "stale",
			boundDigest: "0123456789ab",
			currentDigest: BOUND,
		});
		expect(answer.disregarded).toEqual([]);
		expect(answer.frontier).toBe("awaiting-founder");
	});

	it("resolves a bare marker to unattested and surfaces it — a bare stamp is void", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 3, author: "acme-founder", body: rulingComment("R1.2", BOUND)},
		]);
		expect(answer.questions[1]).toMatchObject({state: "unattested"});
		expect(answer.disregarded[0]).toMatchObject({comment: 3, reason: "unattested"});
		expect(answer.frontier).toBe("awaiting-founder");
	});

	it("disregards a marker whose author is below write, leaving the question open", async () => {
		const {answer} = await readSession(
			[
				ROUND,
				{id: 2, author: "stranger", body: AUTHORIZATION},
				{id: 3, author: "stranger", body: rulingComment("R1.2", BOUND)},
			],
			okOut("read"),
		);
		expect(answer.questions[1]).toMatchObject({state: "open"});
		expect(answer.disregarded[0]).toMatchObject({comment: 3, reason: "unauthorized"});
	});

	it("disregards a ruling naming a question that does not exist", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: AUTHORIZATION},
			{id: 3, author: "acme-founder", body: rulingComment("R9.9", BOUND)},
		]);
		expect(answer.disregarded[0]).toMatchObject({reason: "unbindable"});
	});

	it("disregards a ruling aimed at a fact question", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: AUTHORIZATION},
			{id: 3, author: "acme-founder", body: rulingComment("R1.1", BOUND)},
		]);
		expect(answer.disregarded[0]).toMatchObject({reason: "unbindable"});
		expect(answer.questions[0]).toMatchObject({state: "open"});
	});
});

describe("a malformed marker is visible, never absent", () => {
	it("reports it as a disregarded row at exit 0 and answers the frontier anyway", async () => {
		const {code, answer} = await readSession([
			ROUND,
			{id: 9, author: "acme-founder", body: "grill-ruled: R1.2 @ NOTHEX · 2026-08-09T18:36:48Z\n"},
		]);
		expect(code).toBe(0);
		expect(answer.disregarded[0]).toMatchObject({comment: 9, reason: "malformed"});
		expect(answer.frontier).toBe("awaiting-founder");
	});

	it("never refuses over one bad comment — a malformed marker cannot disable the verb", async () => {
		const {code} = await readSession([
			ROUND,
			{id: 9, author: "acme-founder", body: "grill-answered: nonsense\n"},
			{id: 10, author: "acme-founder", body: "grill-superseded: also nonsense\n"},
		]);
		expect(code).toBe(0);
	});
});

describe("supersession comes from the marker and from nothing else", () => {
	it("reports superseded with the retiring round, whatever the question was before", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: AUTHORIZATION},
			{id: 3, author: "acme-founder", body: rulingComment("R1.2", BOUND)},
			{
				id: 4,
				author: "acme-founder",
				body: supersedeComment([{question: "R1.2", digest: BOUND, round: 2}]),
			},
		]);
		expect(answer.questions[1]).toMatchObject({state: "superseded", supersededBy: 2});
	});

	it("does not read a supersession off a round comment's prose", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: "R1.2 is superseded by the next round.\n"},
		]);
		expect(answer.questions[1]).toMatchObject({state: "open"});
	});

	it("counts a superseded question toward clear", async () => {
		const {answer} = await readSession([
			ROUND,
			{id: 2, author: "acme-founder", body: answerComment("R1.1", BOUND)},
			{
				id: 3,
				author: "acme-founder",
				body: supersedeComment([{question: "R1.2", digest: BOUND, round: 2}]),
			},
		]);
		expect(answer.frontier).toBe("clear");
		expect(answer.counts).toMatchObject({superseded: 1});
	});
});

describe("the only refusals are an absent session and a read that could not complete", () => {
	it("refuses an absent session as proven", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runRead(options),
				fakeShell([[ISSUE, errOut("gh: Not Found (HTTP 404)")]]).layer,
			),
		);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
	});

	it('refuses a comment read that could not complete — never "open"', async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runRead(options),
				fakeShell([
					[ISSUE, okOut(sessionPayload(9412))],
					[COMMENTS, errOut("gh: Bad gateway (HTTP 502)")],
				]).layer,
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain('never "open"');
	});

	it("refuses a permission read that could not complete, naming the marker left unjudged", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runRead(options),
				fakeShell([
					[ISSUE, okOut(sessionPayload(9412))],
					[
						COMMENTS,
						okOut(
							commentsPayload([
								ROUND,
								{id: 3, author: "acme-founder", body: rulingComment("R1.2", BOUND)},
							]),
						),
					],
					[PERMISSION, errOut("gh: Bad gateway (HTTP 502)")],
				]).layer,
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("R1.2");
		expect(out.stderr.join("\n")).toContain("never disregarded and never counted");
	});
});
