import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {CommentRecord} from "../io/issues.ts";
import {
	answerComment,
	roundComment,
	roundDigestOf,
	rulingComment,
	sessionPayload,
	supersedeComment,
} from "./fixtures.test-support.ts";
import {
	nextRoundNumber,
	normalizeTopic,
	questionIndex,
	resolveSession,
	retirements,
	SESSION_LABEL,
	scanMarkers,
	scanRounds,
} from "./session.ts";

const comment = (id: number, author: string, body: string): CommentRecord => ({
	id,
	author,
	createdAt: "2026-08-09T18:00:00Z",
	updatedAt: "2026-08-09T18:00:00Z",
	body,
});

const BOUND = roundDigestOf(1);
const PERMISSION = /^gh api repos\/o\/r\/collaborators\/([a-z-]+)\/permission/;
const ISSUE = /^gh api repos\/o\/r\/issues\/9412$/;

describe("normalizeTopic", () => {
	it.each([
		["SOZLUK Moderation MODEL", "sozluk moderation model"],
		["  sozluk moderation model  ", "sozluk moderation model"],
		["sozluk   moderation\tmodel", "sozluk moderation model"],
	])("folds %s", (raw, expected) => {
		expect(normalizeTopic(raw)).toBe(expected);
	});

	it("does not fold two topics a human reads as different", () => {
		expect(normalizeTopic("sozluk moderation")).not.toBe(normalizeTopic("sozluk moderation model"));
	});
});

describe("resolveSession splits absent from unreadable", () => {
	const resolve = (script: Parameters<typeof fakeShell>[0]) =>
		Effect.runPromise(Effect.provide(resolveSession("o/r", 9412), fakeShell(script).layer));

	it("resolves a labelled issue", async () => {
		expect(await resolve([[ISSUE, okOut(sessionPayload(9412))]])).toMatchObject({_tag: "Session"});
	});

	it("treats an issue without the session label as absent, not as a session", async () => {
		expect(await resolve([[ISSUE, okOut(sessionPayload(9412, {labels: ["bug"]}))]])).toEqual({
			_tag: "Absent",
		});
	});

	it("keeps a 404 and a 502 apart", async () => {
		expect(await resolve([[ISSUE, errOut("gh: Not Found (HTTP 404)")]])).toEqual({_tag: "Absent"});
		expect(await resolve([[ISSUE, errOut("gh: Bad gateway (HTTP 502)")]])).toMatchObject({
			_tag: "Unknown",
		});
	});

	it("names the label the whole group keys on", () => {
		expect(SESSION_LABEL).toBe("grilling:session");
	});
});

describe("scanning rounds", () => {
	it("reads every round and indexes its questions", () => {
		const scan = scanRounds([
			comment(1, "acme-founder", roundComment(1)),
			comment(2, "acme-founder", "Thanks — reading now.\n"),
			comment(3, "acme-founder", roundComment(2)),
		]);
		expect(scan.rounds.map((round) => round.round)).toEqual([1, 2]);
		expect([...questionIndex(scan.rounds).keys()]).toEqual(["R1.1", "R1.2", "R2.1", "R2.2"]);
	});

	it("surfaces a comment that opens as a round and does not parse, rather than skipping it", () => {
		const scan = scanRounds([
			comment(1, "acme-founder", "grill-round: 1\n\n### Background\nprose\n"),
		]);
		expect(scan.rounds).toEqual([]);
		expect(scan.broken[0]).toMatchObject({round: 1, comment: 1});
	});

	it("counts a broken round toward the next round number — a re-post must not collide", () => {
		const scan = scanRounds([
			comment(1, "acme-founder", "grill-round: 3\n\n### Background\nprose\n"),
		]);
		expect(nextRoundNumber(scan)).toBe(4);
	});

	it("says round 1 when there are no rounds — zero is a fact here", () => {
		expect(nextRoundNumber(scanRounds([]))).toBe(1);
	});
});

describe("scanMarkers resolves authority before it counts anything", () => {
	const scan = (comments: ReadonlyArray<CommentRecord>, permission = okOut("write")) =>
		Effect.runPromise(
			Effect.provide(scanMarkers("o/r", comments), fakeShell([[PERMISSION, permission]]).layer),
		);

	it("counts a marker whose author resolves write+", async () => {
		const result = await scan([comment(3, "acme-founder", rulingComment("R1.2", BOUND))]);
		expect(result._tag).toBe("Scanned");
		if (result._tag !== "Scanned") return;
		expect(result.scan.rulings).toHaveLength(1);
		expect(result.scan.disregarded).toEqual([]);
	});

	it("disregards a marker whose author is below write, and says so", async () => {
		const result = await scan(
			[comment(3, "stranger", rulingComment("R1.2", BOUND))],
			okOut("read"),
		);
		if (result._tag !== "Scanned") throw new Error("expected a scan");
		expect(result.scan.rulings).toEqual([]);
		expect(result.scan.disregarded[0]).toMatchObject({reason: "unauthorized"});
	});

	it("returns UNKNOWN, naming the marker, when a permission read fails", async () => {
		const result = await scan(
			[comment(3, "acme-founder", rulingComment("R1.2", BOUND))],
			errOut("gh: Bad gateway (HTTP 502)"),
		);
		expect(result).toMatchObject({_tag: "Unknown", login: "acme-founder", subject: "R1.2"});
	});

	it("resolves each distinct author once", async () => {
		const shell = fakeShell([[PERMISSION, okOut("write")]]);
		await Effect.runPromise(
			Effect.provide(
				scanMarkers("o/r", [
					comment(3, "acme-founder", rulingComment("R1.2", BOUND)),
					comment(4, "acme-founder", answerComment("R1.1", BOUND)),
				]),
				shell.layer,
			),
		);
		expect(shell.calls.filter((call) => PERMISSION.test(call))).toHaveLength(1);
	});

	it("gates the supersede marker at the ACL too — clear is what a downstream skill keys on", async () => {
		const result = await scan(
			[comment(4, "stranger", supersedeComment([{question: "R1.2", digest: BOUND, round: 2}]))],
			okOut("read"),
		);
		if (result._tag !== "Scanned") throw new Error("expected a scan");
		expect(retirements(result.scan).size).toBe(0);
		expect(result.scan.disregarded[0]).toMatchObject({reason: "unauthorized"});
	});

	it("keeps the earliest retiring round when a question is retired twice", async () => {
		const result = await scan([
			comment(4, "acme-founder", supersedeComment([{question: "R1.2", digest: BOUND, round: 3}])),
			comment(5, "acme-founder", supersedeComment([{question: "R1.2", digest: BOUND, round: 2}])),
		]);
		if (result._tag !== "Scanned") throw new Error("expected a scan");
		expect(retirements(result.scan).get("R1.2" as never)).toBe(2);
	});
});
