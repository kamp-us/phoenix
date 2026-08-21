import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {instant, packNonce} from "../wire/handoff-pack.ts";
import {
	commentsJson,
	GROUND,
	ISSUE,
	NONCE,
	OTHER_NONCE,
	packBody,
	REPO,
} from "./fixtures.test-support.ts";
import {composeClaimMarker} from "./markers.ts";
import {resolvePack} from "./packs.ts";

const COMMENTS = new RegExp(`GET .*/issues/${ISSUE}/comments`);
const PERMISSION = /GET .*\/collaborators\/.*\/permission/;

const served = (body: string) => ({status: 200, body});
const writes = served('{"permission":"write"}');

const claim = (nonce: string, packComment: number): string => {
	const key = packNonce(nonce);
	const at = instant("2026-08-09T19:02:11Z");
	if (key === null || at === null) throw new Error("fixture does not conform");
	return composeClaimMarker({nonce: key, packComment, claimedAt: at});
};

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(resolvePack(REPO, ISSUE), fakeSeams(script).layer));

describe("resolvePack", () => {
	it("answers None over an issue whose comments carry no pack — zero packs is a fact", async () => {
		const out = await run([[COMMENTS, served(commentsJson([{id: 1, body: "picking this up"}]))]]);
		expect(out).toMatchObject({_tag: "None", comments: 1, disregarded: []});
	});

	it("answers Unknown when the comment walk could not complete — never None", async () => {
		const out = await run([[COMMENTS, {status: 502, body: "{}"}]]);
		expect(out).toMatchObject({_tag: "Unknown"});
	});

	it("honours the latest authorized pack", async () => {
		const out = await run([
			[PERMISSION, writes],
			[COMMENTS, served(commentsJson([{id: 1, body: packBody()}]))],
		]);
		expect(out).toMatchObject({_tag: "Sealed", heldBy: null});
		if (out._tag !== "Sealed") return;
		expect(out.sealed.comment).toBe(1);
		expect(out.sealed.ground.git.branch).toBe(GROUND.git.branch);
	});

	it("refuses a malformed latest pack rather than reporting no pack over a pack that exists", async () => {
		const out = await run([
			[PERMISSION, writes],
			[
				COMMENTS,
				served(
					commentsJson([
						{id: 1, body: packBody()},
						{id: 2, body: packBody().replace("## Next act", "## Next steps")},
					]),
				),
			],
		]);
		expect(out).toMatchObject({_tag: "Malformed", comment: 2});
	});

	it("refuses a pack whose digest disagrees with the fields it labels", async () => {
		const out = await run([
			[PERMISSION, writes],
			[COMMENTS, served(commentsJson([{id: 1, body: packBody({digest: "aaaaaaaaaaaa"})}]))],
		]);
		expect(out).toMatchObject({_tag: "Malformed", comment: 1});
		if (out._tag !== "Malformed") return;
		expect(out.reason).toContain("recomputed");
	});

	it("disregards a pack from an author below write and keeps looking at older ones", async () => {
		const out = await run([
			[/GET .*\/collaborators\/stranger\/permission/, served('{"permission":"read"}')],
			[PERMISSION, writes],
			[
				COMMENTS,
				served(
					commentsJson([
						{id: 1, body: packBody()},
						{id: 2, body: packBody({unsure: "nothing"}), author: "stranger"},
					]),
				),
			],
		]);
		expect(out).toMatchObject({_tag: "Sealed"});
		if (out._tag !== "Sealed") return;
		expect(out.sealed.comment).toBe(1);
		expect(out.disregarded).toMatchObject([{kind: "pack", comment: 2, reason: "unauthorized"}]);
	});

	it("answers Unknown when a permission read failed — a failed lookup is never a grant", async () => {
		const out = await run([
			[PERMISSION, {status: 502, body: "{}"}],
			[COMMENTS, served(commentsJson([{id: 1, body: packBody()}]))],
		]);
		expect(out).toMatchObject({_tag: "Unknown"});
	});

	it("reports the holder of a claim on the honoured pack", async () => {
		const out = await run([
			[PERMISSION, writes],
			[
				COMMENTS,
				served(
					commentsJson([
						{id: 1, body: packBody()},
						{id: 2, body: claim(NONCE, 1)},
					]),
				),
			],
		]);
		expect(out).toMatchObject({_tag: "Sealed", heldBy: {claimNonce: NONCE, claimComment: 2}});
	});

	it("surfaces a claim on a superseded pack rather than leaving the field empty", async () => {
		const out = await run([
			[PERMISSION, writes],
			[
				COMMENTS,
				served(
					commentsJson([
						{id: 1, body: packBody()},
						{id: 2, body: claim(OTHER_NONCE, 1)},
						{id: 3, body: packBody({unsure: "a second pass"})},
					]),
				),
			],
		]);
		expect(out).toMatchObject({_tag: "Sealed", heldBy: null});
		if (out._tag !== "Sealed") return;
		expect(out.sealed.comment).toBe(3);
		expect(out.disregarded).toMatchObject([{kind: "claim", comment: 2, reason: "superseded"}]);
	});
});
