import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {
	anySessionCaller,
	laneCaller,
	requireCallerToken,
	requireClaim,
	resolveOwnership,
} from "./claim.ts";
import {CLAIM_NOT_MINE} from "./codes.ts";
import {
	adoptMarker,
	comments,
	GONE_NONCE,
	GONE_TOKEN,
	GONE_UUID,
	HEIR_NONCE,
	HEIR_TOKEN,
	HEIR_UUID,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NONCE,
	SIBLING_NONCE,
	SIBLING_TOKEN,
	SIBLING_UUID,
	served,
} from "./fixtures.test-support.ts";

const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;

const WRITE = served({permission: "write"});

const run = <A>(
	effect: Effect.Effect<A, never, ChildProcessSpawner.ChildProcessSpawner>,
	script: ReadonlyArray<Scripted>,
) => Effect.runPromise(Effect.provide(effect, fakeSeams(script).layer));

/**
 * Two lanes, one session id, one number — the shape the session-only rule could not see (#6037). The
 * earlier marker is lane A's; lane B reads the same thread and must be told it lost.
 */
const BOTH_LANES: ReadonlyArray<Scripted> = [
	[
		COMMENTS,
		comments(
			{id: 9001, body: marker("s-9f2e", LANE_UUID)},
			{id: 9002, body: marker("s-9f2e", SIBLING_UUID)},
		),
	],
	[PERM, WRITE],
];

describe("resolveOwnership", () => {
	it("gives the winning marker's own lane Mine", async () => {
		const {ownership} = await run(
			resolveOwnership("o/r", 4312, laneCaller("s-9f2e", NONCE, LANE_TOKEN)),
			BOTH_LANES,
		);
		expect(ownership._tag).toBe("Mine");
		expect(ownership._tag === "Mine" && ownership.marker.token).toBe(LANE_TOKEN);
	});

	it("gives the sibling lane of the SAME session Foreign, not Mine", async () => {
		const {ownership} = await run(
			resolveOwnership("o/r", 4312, laneCaller("s-9f2e", SIBLING_NONCE, SIBLING_TOKEN)),
			BOTH_LANES,
		);
		expect(ownership._tag).toBe("Foreign");
		expect(ownership._tag === "Foreign" && ownership.marker.token).toBe(LANE_TOKEN);
		expect(ownership._tag === "Foreign" && ownership.sameSession).toBe(true);
	});

	it("marks a genuinely other session's win as not same-session, so no caller re-maps it to a wrong lane", async () => {
		const {ownership} = await run(
			resolveOwnership("o/r", 4312, laneCaller("s-9f2e", NONCE, LANE_TOKEN)),
			[
				[COMMENTS, comments({id: 9001, body: marker("s-77aa", LANE_UUID)})],
				[PERM, WRITE],
			],
		);
		expect(ownership._tag === "Foreign" && ownership.sameSession).toBe(false);
	});

	it("still answers Mine on the one-lane-per-session path, unchanged", async () => {
		const {ownership} = await run(
			resolveOwnership("o/r", 4312, laneCaller("s-9f2e", NONCE, LANE_TOKEN)),
			[
				[COMMENTS, comments({id: 9001, body: marker("s-9f2e", LANE_UUID)})],
				[PERM, WRITE],
			],
		);
		expect(ownership._tag).toBe("Mine");
	});

	it("lets an AnySession caller hold any lane of its session — the namespaces that have no nonce", async () => {
		const {ownership} = await run(
			resolveOwnership("o/r", 4312, anySessionCaller("s-9f2e")),
			BOTH_LANES,
		);
		expect(ownership._tag).toBe("Mine");
	});
});

describe("resolveOwnership — the adopt fence (#7010)", () => {
	/** A claim by the gone session, then an authorized succession handing it to the heir. */
	const SUCCEEDED: ReadonlyArray<Scripted> = [
		[
			COMMENTS,
			comments(
				{id: 9101, body: marker("s-gone", GONE_UUID)},
				{id: 9102, body: adoptMarker("s-gone", "s-heir", HEIR_UUID)},
			),
		],
		[PERM, WRITE],
	];

	it("reads Foreign for the resumed dead lane — never Mine across one succession", async () => {
		const {ownership} = await run(
			resolveOwnership("o/r", 4312, laneCaller("s-gone", GONE_NONCE, GONE_TOKEN)),
			SUCCEEDED,
		);
		expect(ownership._tag).toBe("Foreign");
	});

	it("still reads Mine for the heir the adopt names, carrying the adopt", async () => {
		const {ownership} = await run(
			resolveOwnership("o/r", 4312, laneCaller("s-heir", HEIR_NONCE, HEIR_TOKEN)),
			SUCCEEDED,
		);
		expect(ownership._tag).toBe("Mine");
		expect(ownership._tag === "Mine" && ownership.adopt?.token).toBe(HEIR_TOKEN);
	});

	it("does not fence on an unauthorized adoption — the succession never legally happened", async () => {
		const {ownership, unauthorizedAdopts} = await run(
			resolveOwnership("o/r", 4312, laneCaller("s-gone", GONE_NONCE, GONE_TOKEN)),
			[
				[
					COMMENTS,
					comments(
						{id: 9101, body: marker("s-gone", GONE_UUID)},
						{
							id: 9102,
							body: adoptMarker("s-gone", "s-heir", HEIR_UUID),
							author: "ghost",
						},
					),
				],
				[PERM, WRITE],
				[/GET .*\/repos\/o\/r\/collaborators\/ghost\/permission/, served({permission: "read"})],
			],
		);
		expect(ownership._tag).toBe("Mine");
		expect(unauthorizedAdopts.length).toBe(1);
	});
});

describe("requireClaim", () => {
	it("refuses the sibling lane on 15, naming the winner and the asking lane", async () => {
		const held = await run(
			requireClaim("build note", "o/r", 4312, laneCaller("s-9f2e", SIBLING_NONCE, SIBLING_TOKEN)),
			BOTH_LANES,
		);
		expect(held._tag).toBe("Refused");
		if (held._tag !== "Refused") return;
		expect(held.outcome.code).toBe(CLAIM_NOT_MINE);
		expect(held.outcome.stderr.at(-1)).toBe(
			`build note: #4312 is held by ${LANE_TOKEN}, not by ${SIBLING_TOKEN}.`,
		);
	});

	it("holds for the lane that actually won", async () => {
		const held = await run(
			requireClaim("build note", "o/r", 4312, laneCaller("s-9f2e", NONCE, LANE_TOKEN)),
			BOTH_LANES,
		);
		expect(held._tag).toBe("Held");
	});

	it("carries the succession on Held, so a run keys on the adopt token (#7010)", async () => {
		const held = await run(
			requireClaim("build note", "o/r", 4312, laneCaller("s-heir", HEIR_NONCE, HEIR_TOKEN)),
			[
				[
					COMMENTS,
					comments(
						{id: 9101, body: marker("s-gone", GONE_UUID)},
						{id: 9102, body: adoptMarker("s-gone", "s-heir", HEIR_UUID)},
					),
				],
				[PERM, WRITE],
			],
		);
		expect(held._tag).toBe("Held");
		expect(held._tag === "Held" && held.adopt?.token).toBe(HEIR_TOKEN);
	});

	it("refuses the resumed dead lane on 15 across a succession (#7010)", async () => {
		const held = await run(
			requireClaim("build note", "o/r", 4312, laneCaller("s-gone", GONE_NONCE, GONE_TOKEN)),
			[
				[
					COMMENTS,
					comments(
						{id: 9101, body: marker("s-gone", GONE_UUID)},
						{id: 9102, body: adoptMarker("s-gone", "s-heir", HEIR_UUID)},
					),
				],
				[PERM, WRITE],
			],
		);
		expect(held._tag).toBe("Refused");
		if (held._tag !== "Refused") return;
		expect(held.outcome.code).toBe(CLAIM_NOT_MINE);
	});
});

describe("requireCallerToken", () => {
	it("reads the lane's nonce off its token", () => {
		const read = requireCallerToken("build note", "s-9f2e", ` ${LANE_TOKEN} `);
		expect(read._tag === "Caller" && read.caller.nonce).toBe(NONCE);
	});

	it("refuses a token shaped like anything else on 1", () => {
		const read = requireCallerToken("build note", "s-9f2e", "s-9f2e");
		expect(read._tag === "Refused" && read.outcome.code).toBe(FAILED);
	});

	it("refuses a token belonging to another session on 1 — a lane names itself, never another", () => {
		const read = requireCallerToken("build note", "s-9f2e", `build:s-77aa:${LANE_UUID}`);
		expect(read._tag === "Refused" && read.outcome.code).toBe(FAILED);
	});
});
