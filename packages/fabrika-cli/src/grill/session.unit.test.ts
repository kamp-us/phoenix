import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
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
const PERMISSION = /^GET .*\/repos\/o\/r\/collaborators\/[a-z-]+\/permission$/;
const ISSUE = /^GET .*\/repos\/o\/r\/issues\/9412$/;

const served = (payload: unknown): HttpReply => ({status: 200, body: JSON.stringify(payload)});
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

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
	const resolve = (script: ReadonlyArray<Scripted>) =>
		Effect.runPromise(Effect.provide(resolveSession("o/r", 9412), fakeSeams(script).layer));

	it("resolves a labelled issue", async () => {
		expect(await resolve([[ISSUE, {status: 200, body: sessionPayload(9412)}]])).toMatchObject({
			_tag: "Session",
		});
	});

	it("treats an issue without the session label as absent, not as a session", async () => {
		expect(
			await resolve([[ISSUE, {status: 200, body: sessionPayload(9412, {labels: ["bug"]})}]]),
		).toEqual({_tag: "Absent"});
	});

	it("keeps a 404 and a 502 apart", async () => {
		expect(await resolve([[ISSUE, NOT_FOUND]])).toEqual({_tag: "Absent"});
		expect(await resolve([[ISSUE, GATEWAY]])).toMatchObject({_tag: "Unknown"});
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
	const granted = (permission: string): HttpReply => served({permission});

	const scan = (comments: ReadonlyArray<CommentRecord>, permission = granted("write")) =>
		Effect.runPromise(
			Effect.provide(scanMarkers("o/r", comments), fakeSeams([[PERMISSION, permission]]).layer),
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
			granted("read"),
		);
		if (result._tag !== "Scanned") throw new Error("expected a scan");
		expect(result.scan.rulings).toEqual([]);
		expect(result.scan.disregarded[0]).toMatchObject({reason: "unauthorized"});
	});

	it("returns UNKNOWN, naming the marker, when a permission read fails", async () => {
		const result = await scan([comment(3, "acme-founder", rulingComment("R1.2", BOUND))], GATEWAY);
		expect(result).toMatchObject({_tag: "Unknown", login: "acme-founder", subject: "R1.2"});
	});

	it("resolves each distinct author once", async () => {
		const seams = fakeSeams([[PERMISSION, granted("write")]]);
		await Effect.runPromise(
			Effect.provide(
				scanMarkers("o/r", [
					comment(3, "acme-founder", rulingComment("R1.2", BOUND)),
					comment(4, "acme-founder", answerComment("R1.1", BOUND)),
				]),
				seams.layer,
			),
		);
		expect(seams.requests.filter((request) => PERMISSION.test(request))).toHaveLength(1);
	});

	it("gates the supersede marker at the ACL too — clear is what a downstream skill keys on", async () => {
		const result = await scan(
			[comment(4, "stranger", supersedeComment([{question: "R1.2", digest: BOUND, round: 2}]))],
			granted("read"),
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
