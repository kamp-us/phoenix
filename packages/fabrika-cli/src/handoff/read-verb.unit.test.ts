import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {instant, packNonce} from "../wire/handoff-pack.ts";
import {NO_TARGET, PACK_MALFORMED, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	commentsJson,
	GROUND,
	groundScript,
	ISSUE,
	NONCE,
	packBody,
	REPO,
} from "./fixtures.test-support.ts";
import {composeClaimMarker} from "./markers.ts";
import {runRead} from "./read-verb.ts";

const LIST = new RegExp(`issues/${ISSUE}/comments`);

const claim = (packComment: number): string => {
	const nonce = packNonce(NONCE);
	const at = instant("2026-08-09T19:02:11Z");
	if (nonce === null || at === null) throw new Error("fixture does not conform");
	return composeClaimMarker({nonce, packComment, claimedAt: at});
};

const options = {issue: ISSUE, base: null, repo: null, env: {CLAUDE_PIPELINE_REPO: REPO}};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	over: Partial<typeof options> = {},
) => Effect.runPromise(Effect.provide(runRead({...options, ...over}), fakeShell(script).layer));

describe("runRead", () => {
	it("exits 0 with `none` over an issue nobody handed off — the ordinary case", async () => {
		const out = await run([
			[LIST, okOut(commentsJson([{id: 1, body: "picking this up"}]))],
			...groundScript(),
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			issue: ISSUE,
			pack: "none",
			packComment: null,
			packNonce: null,
			sealedAt: null,
			author: null,
			asserted: null,
			ground: null,
			drift: null,
			heldBy: null,
			disregarded: [],
			scanned: {comments: 1},
		});
	});

	it("reports drift none when the live ground still matches the packed one", async () => {
		const out = await run([
			[LIST, okOut(commentsJson([{id: 9234567891, body: packBody()}]))],
			...groundScript(),
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.pack).toBe("sealed");
		expect(answer.ground).toEqual({packed: GROUND.groundDigest});
		expect(answer.drift).toEqual({packedBranch: "resolves", state: "none", fields: []});
		expect(answer.asserted.nextAct).toBe(
			"Follow one level of local helper call, then re-run the case.",
		);
	});

	it("re-derives against the PACKED branch, not the successor's HEAD", async () => {
		const out = await run([
			[LIST, okOut(commentsJson([{id: 1, body: packBody()}]))],
			// A successor sitting on `main`: were the derivation taken from HEAD, ten rows would move.
			[/rev-parse --abbrev-ref HEAD$/, okOut("main")],
			...groundScript(),
		]);
		expect(JSON.parse(out.stdout).drift.state).toBe("none");
	});

	it("reports the moved field, and only that one", async () => {
		const moved = "7ab3419e0c25d8f6041a2b3c4d5e6f7089abcdef";
		const out = await run([
			[LIST, okOut(commentsJson([{id: 1, body: packBody()}]))],
			[/rev-parse --verify --quiet main\^/, okOut(GROUND.git.base.head)],
			[/rev-parse --verify --quiet/, okOut(moved)],
			...groundScript(),
		]);
		const drift = JSON.parse(out.stdout).drift;
		expect(drift.state).toBe("moved");
		expect(drift.fields.map((row: {field: string}) => row.field)).toEqual(["git.head"]);
	});

	it("reports the third token, `claimed`, with its holder", async () => {
		const out = await run([
			[
				LIST,
				okOut(
					commentsJson([
						{id: 1, body: packBody()},
						{id: 2, body: claim(1)},
					]),
				),
			],
			...groundScript(),
		]);
		const answer = JSON.parse(out.stdout);
		expect(out.code).toBe(0);
		expect(answer.pack).toBe("claimed");
		expect(answer.heldBy).toEqual({
			claimNonce: NONCE,
			claimedAt: "2026-08-09T19:02:11Z",
			claimComment: 2,
			by: "usirin",
		});
	});

	it("reports rows 3-10 as moved with a null live value when the packed branch is gone", async () => {
		const out = await run([
			[LIST, okOut(commentsJson([{id: 1, body: packBody()}]))],
			[/rev-parse --verify --quiet/, errOut("")],
			...groundScript(),
		]);
		expect(out.code).toBe(0);
		const drift = JSON.parse(out.stdout).drift;
		expect(drift.packedBranch).toBe("gone");
		expect(drift.fields.filter((row: {live: unknown}) => row.live !== null)).toEqual([]);
	});

	it("exits 14 on a malformed latest pack — never `none` over a pack that exists", async () => {
		const out = await run([
			[LIST, okOut(commentsJson([{id: 77, body: packBody().replace("## Unsure", "## Doubts")}]))],
			...groundScript(),
		]);
		expect(out.code).toBe(PACK_MALFORMED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("Read #77");
	});

	it("exits 11 when the comment walk failed — whether a pack exists is UNKNOWN, never none", async () => {
		const out = await run([[LIST, errOut("gh: Bad gateway (HTTP 502)")], ...groundScript()]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 11 when the live re-derivation failed — the drift is not reported as unchanged", async () => {
		const out = await run([
			[LIST, okOut(commentsJson([{id: 1, body: packBody()}]))],
			[/pulls\?state=all/, errOut("gh: Bad gateway (HTTP 502)")],
			...groundScript(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 7 on an issue that does not exist", async () => {
		const out = await run([
			[new RegExp(`api repos/${REPO}/issues/${ISSUE}$`), errOut("gh: Not Found (HTTP 404)")],
			...groundScript(),
		]);
		expect(out.code).toBe(NO_TARGET);
	});
});
