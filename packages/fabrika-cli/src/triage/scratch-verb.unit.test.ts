import {Effect, FileSystem, Layer, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {composeClaimToken} from "./claim.ts";
import {COMMENTS, claimPage, EXPIRED, LIVE} from "./claim-fixtures.test-support.ts";
import {CLAIM_NOT_HELD, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {runScratch} from "./scratch-verb.ts";

const SESSION = "s-9f2e";
/** Two lanes of ONE session — the fan-out shape #6630 is about. */
const UUID_A = "c1a4d6f8-0000-4000-8000-000000000001";
const UUID_B = "b7e30912-0000-4000-8000-000000000002";
const TOKEN_A = composeClaimToken(SESSION, UUID_A);
const TOKEN_B = composeClaimToken(SESSION, UUID_B);
const NONCE_A = "c1a4d6f8";
const NONCE_B = "b7e30912";

const options = {
	issue: 4312,
	slug: "authored",
	token: TOKEN_A,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: SESSION} as Record<
		string,
		string | undefined
	>,
	tmpRoot: "/scratch-root",
	now: () => new Date("2026-08-20T18:00:00Z"),
};

const held = (lane: string): ReadonlyArray<Scripted> => [
	[COMMENTS, claimPage({session: SESSION, createdAt: LIVE, lane})],
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runScratch({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, fakeFs({}).layer),
		),
	);

describe("runScratch", () => {
	it("keys the directory on session, issue and the CALLER token's lane nonce", async () => {
		const out = await run(held(NONCE_A));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`/scratch-root/fabrika-triage/${SESSION}/4312-${NONCE_A}/authored\n`);
	});

	/**
	 * The whole point of the verb: a fan-out runs under one session id, so two lanes asking for the
	 * same slug on the same issue must not be handed the same file (#6630).
	 */
	it("hands two lanes of one session two directories on one issue", async () => {
		const first = await run(held(NONCE_A));
		const second = await run(
			[[COMMENTS, claimPage({session: SESSION, createdAt: LIVE, lane: NONCE_B})]],
			{token: TOKEN_B},
		);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(second.stdout).not.toBe(first.stdout);
		expect(second.stdout).toContain(`4312-${NONCE_B}/`);
	});

	it("refuses a slug carrying a path separator on 10, with no path on stdout", async () => {
		const out = await run([], {slug: "notes/inner"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			'triage scratch: --slug "notes/inner" must be a kebab-case leaf, no path separators.',
		);
	});

	it("refuses a non-kebab slug on 10", async () => {
		const out = await run([], {slug: "Authored"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
	});

	it("refuses a token carrying another session on 1 — a lane names itself, never another", async () => {
		const out = await run(held(NONCE_A), {token: composeClaimToken("s-77aa", UUID_A)});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("carries session s-77aa, but this run is session s-9f2e");
	});

	it("refuses a token that is not a triage claim token on 1", async () => {
		const out = await run(held(NONCE_A), {token: `build:${SESSION}:${UUID_A}`});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("is not a claim token");
	});

	it("refuses an unstamped session on 1", async () => {
		const out = await run(held(NONCE_A), {
			env: {CLAUDE_PIPELINE_REPO: "o/r"},
		});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("CLAUDE_CODE_SESSION_ID is unset");
	});

	it("refuses a session id that is not one path segment on 1", async () => {
		const out = await run(held(NONCE_A), {
			env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s/../root"},
			token: composeClaimToken("s/../root", UUID_A),
		});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("is not one path segment");
	});

	it("refuses on 19 when no marker of this lane is live — no lane, no namespace", async () => {
		const out = await run([[COMMENTS, {status: 200, body: "[]"}]]);
		expect(out.code).toBe(CLAIM_NOT_HELD);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("holds no live claim on #4312");
	});

	it("refuses on 19 when this lane's own marker has aged out", async () => {
		const out = await run([
			[COMMENTS, claimPage({session: SESSION, createdAt: EXPIRED, lane: NONCE_A})],
		]);
		expect(out.code).toBe(CLAIM_NOT_HELD);
		expect(out.stdout).toBe("");
	});

	/** A sibling lane got there first: this lane holds a marker, and it is not the earliest. */
	it("refuses on 19 when a sibling lane of the same session won the race", async () => {
		const out = await run([
			[
				COMMENTS,
				claimPage(
					{session: SESSION, createdAt: "2026-08-20T17:00:00Z", lane: NONCE_B},
					{session: SESSION, createdAt: "2026-08-20T17:30:00Z", lane: NONCE_A},
				),
			],
		]);
		expect(out.code).toBe(CLAIM_NOT_HELD);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(`held by the lane on nonce ${NONCE_B}`);
	});

	it("refuses an unreadable comment list on 11 — UNKNOWN, never an allocated path", async () => {
		const out = await run([[COMMENTS, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unorderable marker set on 11", async () => {
		const out = await run([
			[COMMENTS, claimPage({session: SESSION, createdAt: "not-a-date", lane: NONCE_A})],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses an unmakeable directory on 1 — never a path it could not allocate", async () => {
		const unmakeable = FileSystem.layerNoop({
			makeDirectory: (path: string) =>
				Effect.fail(
					PlatformError.systemError({
						_tag: "PermissionDenied",
						module: "FileSystem",
						method: "makeDirectory",
						pathOrDescriptor: path,
					}),
				),
		});
		const out = await Effect.runPromise(
			Effect.provide(runScratch(options), Layer.merge(fakeSeams(held(NONCE_A)).layer, unmakeable)),
		);
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("triage scratch: cannot create ");
	});
});
