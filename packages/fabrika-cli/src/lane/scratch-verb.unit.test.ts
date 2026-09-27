import {Effect, FileSystem, Layer, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {comments, LANE_UUID, NONCE, SIBLING_UUID, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {scanBody} from "../report/leaks.ts";
import {FAILED} from "../verb.ts";
import {CLAIM_NOT_MINE, LANE_UNREADABLE, SLUG_OFF_VOCABULARY} from "./codes.ts";
import {parseKey} from "./key.ts";
import {runLaneScratch} from "./scratch-verb.ts";

const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/5492\/comments\?/;
const PERM = /^GET .*\/repos\/o\/r\/collaborators\/agent\/permission$/;
const WRITE = served({permission: "write"});

const laneMarker = (session: string, uuid: string): string =>
	`lane-claim: lane:${session}:${uuid} · 2026-08-17T00:00:00Z`;

const MY_TOKEN = `lane:s-9f2e:${LANE_UUID}`;
const SIBLING_TOKEN = `lane:s-9f2e:${SIBLING_UUID}`;
const SIBLING_NONCE = SIBLING_UUID.slice(0, 8);

const key = (raw: string) => {
	const parsed = parseKey(raw);
	if (parsed._tag === "Malformed") throw new Error(`fixture key "${raw}" is malformed`);
	return parsed.key;
};

const heldBy = (...uuids: ReadonlyArray<string>): ReadonlyArray<Scripted> => [
	[
		COMMENTS,
		comments(...uuids.map((uuid, index) => ({id: index + 1, body: laneMarker("s-9f2e", uuid)}))),
	],
	[PERM, WRITE],
];

const options = {
	key: key("5492"),
	lane: "5492",
	slug: "helpers",
	token: MY_TOKEN,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
	tmpRoot: "/scratch-root",
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runLaneScratch({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, fakeFs({}).layer),
		),
	);

describe("runLaneScratch", () => {
	it("keys the namespace on the lane-claim NONCE of the caller's token", async () => {
		const out = await run(heldBy(LANE_UUID));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`/scratch-root/fabrika-lane/s-9f2e/5492-${NONCE}/helpers\n`);
	});

	/**
	 * The defect this verb exists for: two drivers of one session wrote one shared helper. Each token
	 * proves its own claim here, so the two answers are read off two different nonces.
	 */
	it("hands two drivers of one session two different paths", async () => {
		const mine = await run(heldBy(LANE_UUID));
		const sibling = await run(
			[
				[COMMENTS, comments({id: 1, body: laneMarker("s-9f2e", SIBLING_UUID)})],
				[PERM, WRITE],
			],
			{token: SIBLING_TOKEN},
		);
		expect(sibling.code).toBe(0);
		expect(sibling.stdout).toBe(
			`/scratch-root/fabrika-lane/s-9f2e/5492-${SIBLING_NONCE}/helpers\n`,
		);
		expect(sibling.stdout).not.toBe(mine.stdout);
	});

	it("refuses a slug carrying a path separator on 10", async () => {
		const out = await run([], {slug: "helpers/fab"});
		expect(out.code).toBe(SLUG_OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			'lane scratch: --slug "helpers/fab" must be a kebab-case leaf, no path separators.',
		);
	});

	it("refuses a non-kebab slug on 10", async () => {
		const out = await run([], {slug: "Helpers"});
		expect(out.code).toBe(SLUG_OFF_VOCABULARY);
		expect(out.stdout).toBe("");
	});

	it("refuses a token of a sibling driver whose claim does not stand on 31", async () => {
		const out = await run(heldBy(SIBLING_UUID));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stdout).toBe("");
	});

	it("refuses a token when no lane claim stands at all on 31", async () => {
		const out = await run([
			[COMMENTS, comments()],
			[PERM, WRITE],
		]);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stdout).toBe("");
	});

	it("refuses a token minted by another session on 1, before any board read", async () => {
		const out = await run([], {token: `lane:s-77aa:${LANE_UUID}`});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
	});

	it("refuses a build-claim token on 1 — the driver's namespace admits only its own grammar", async () => {
		const out = await run([], {token: `build:s-9f2e:${LANE_UUID}`});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
	});

	it("reads an unreadable marker set as UNKNOWN on 11, never as held", async () => {
		const out = await run([[COMMENTS, {status: 502, body: '{"message":"Bad gateway"}'}]]);
		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("refuses a chore lane on 1 — no claim, so no nonce to key on", async () => {
		const out = await run([], {key: key("chore:park-sweep"), lane: "chore:park-sweep"});
		expect(out.code).toBe(FAILED);
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
			Effect.provide(
				runLaneScratch(options),
				Layer.merge(fakeSeams(heldBy(LANE_UUID)).layer, unmakeable),
			),
		);
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
	});

	/** The same redaction `build scratch`'s path gets: the leak scan every posting verb runs. */
	it("prints a path every posting verb's leak scan redacts", async () => {
		for (const tmpRoot of ["/private/tmp", "/var/folders/z9/t0000000/T", "/tmp"]) {
			const out = await run(heldBy(LANE_UUID), {tmpRoot});
			const path = out.stdout.trim();
			const scan = scanBody(`helper lives at ${path}`);
			expect(scan.leaks).toHaveLength(1);
			expect(scan.redacted).not.toContain("fabrika-lane");
		}
	});
});
