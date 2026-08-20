import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {instant, packNonce} from "../wire/handoff-pack.ts";
import {runClaim} from "./claim-verb.ts";
import {
	NO_PACK,
	PACK_CLAIMED,
	PACK_MALFORMED,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commentsJson,
	groundScript,
	ISSUE,
	NONCE,
	OTHER_NONCE,
	packBody,
	REPO,
} from "./fixtures.test-support.ts";
import {composeClaimMarker} from "./markers.ts";

const POST = new RegExp(`POST .*/repos/${REPO}/issues/${ISSUE}/comments`);
const GET_COMMENT = /GET .*\/issues\/comments\/\d+/;
const LIST = new RegExp(`GET .*/issues/${ISSUE}/comments`);
const PACK_COMMENT = 9234567891;

const claim = (nonce: string, packComment = PACK_COMMENT): string => {
	const key = packNonce(nonce);
	const at = instant("2026-08-09T19:02:11Z");
	if (key === null || at === null) throw new Error("fixture does not conform");
	return composeClaimMarker({nonce: key, packComment, claimedAt: at});
};

const options = {
	issue: ISSUE,
	nonce: NONCE,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
	now: () => new Date("2026-08-09T19:02:11.000Z"),
};

const run = (script: ReadonlyArray<Scripted>, over: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runClaim({...options, ...over}), fakeSeams(script).layer));

const sealed = (comments: ReadonlyArray<{readonly id: number; readonly body: string}>) =>
	[[LIST, {status: 200, body: commentsJson(comments)}], ...groundScript()] as const;

describe("runClaim", () => {
	it("exits 1 on a claim key two runs would collide on", async () => {
		const out = await run([], {nonce: "run-1"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("run-1");
	});

	it("exits 13 when the issue carries no sealed pack — a claim on nothing cannot be honoured", async () => {
		const out = await run([...sealed([{id: 1, body: "picking this up"}])]);
		expect(out.code).toBe(NO_PACK);
		expect(out.stdout).toBe("");
	});

	it("exits 0 and holds the pack when it is free", async () => {
		const body = claim(NONCE);
		const out = await run([
			[POST, {status: 201, body: '{"id":9234599999,"html_url":"u"}'}],
			[GET_COMMENT, {status: 200, body: JSON.stringify({body})}],
			...sealed([{id: PACK_COMMENT, body: packBody()}]),
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			issue: ISSUE,
			packComment: PACK_COMMENT,
			claimNonce: NONCE,
			claim: "held",
			claimedAt: "2026-08-09T19:02:11Z",
			claimComment: 9234599999,
		});
	});

	it("exits 0 with `resumed` and posts no second comment when this nonce already holds it", async () => {
		const seams = fakeSeams([
			...sealed([
				{id: PACK_COMMENT, body: packBody()},
				{id: 9234599999, body: claim(NONCE)},
			]),
		]);
		const out = await Effect.runPromise(Effect.provide(runClaim(options), seams.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).claim).toBe("resumed");
		expect(seams.requests.filter((line) => line.startsWith("POST"))).toEqual([]);
	});

	it("exits 15 when another nonce holds the pack", async () => {
		const out = await run([
			...sealed([
				{id: PACK_COMMENT, body: packBody()},
				{id: 9234599999, body: claim(OTHER_NONCE)},
			]),
		]);
		expect(out.code).toBe(PACK_CLAIMED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(OTHER_NONCE);
	});

	it("exits 14 rather than claiming a pack whose contents are UNKNOWN", async () => {
		const out = await run([
			...sealed([{id: PACK_COMMENT, body: packBody({digest: "aaaaaaaaaaaa"})}]),
		]);
		expect(out.code).toBe(PACK_MALFORMED);
		expect(out.stdout).toBe("");
	});

	it("exits 11 when the comment walk failed — whether a pack is claimed is UNKNOWN, never free", async () => {
		const out = await run([[LIST, {status: 502, body: "{}"}], ...groundScript()]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 8 when the claim write failed — whether the claim holds is UNKNOWN", async () => {
		const out = await run([
			[POST, {status: 502, body: "{}"}],
			...sealed([{id: PACK_COMMENT, body: packBody()}]),
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 9 when the posted claim does not read back — the stamp is verified, never assumed", async () => {
		const out = await run([
			[POST, {status: 201, body: '{"id":9234599999,"html_url":"u"}'}],
			[GET_COMMENT, {status: 200, body: JSON.stringify({body: "something else entirely"})}],
			...sealed([{id: PACK_COMMENT, body: packBody()}]),
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
	});
});
