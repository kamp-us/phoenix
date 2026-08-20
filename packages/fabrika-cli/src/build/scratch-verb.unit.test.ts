import {Effect, FileSystem, Layer, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {CLAIM_NOT_MINE, OFF_VOCABULARY} from "./codes.ts";
import {
	comments,
	issue,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NONCE,
	served,
} from "./fixtures.test-support.ts";
import {runScratch} from "./scratch-verb.ts";

/** The write permission the marker's author holds — what authorizes a claim (ADR 0055). */
const WRITE = served({permission: "write"});

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;

const CLAIMED: ReadonlyArray<Scripted> = [
	[ISSUE, issue()],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, WRITE],
];

const options = {
	number: 4312,
	slug: "notes",
	token: LANE_TOKEN,
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
			runScratch({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, fakeFs({}).layer),
		),
	);

describe("runScratch", () => {
	/**
	 * The nonce in the key is the whole fix: v1 keyed on the session id alone, so two lanes of one
	 * session shared a namespace and clobbered each other's fixed-name files (#4516, #4544).
	 */
	it("keys the namespace on the CLAIM NONCE, not the session alone", async () => {
		const out = await run(CLAIMED);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`/scratch-root/fabrika-build/s-9f2e/4312-${NONCE}/notes\n`);
	});

	it("refuses a slug carrying a path separator on 10", async () => {
		const out = await run([], {slug: "notes/inner"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			'build scratch: --slug "notes/inner" must be a kebab-case leaf, no path separators.',
		);
	});

	it("refuses a non-kebab slug on 10", async () => {
		const out = await run([], {slug: "Notes"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a foreign claim on 15 — no lane, no namespace", async () => {
		const out = await run([
			[ISSUE, issue()],
			[COMMENTS, comments({id: 1, body: marker("s-77aa", LANE_UUID)})],
			[PERM, WRITE],
		]);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stdout).toBe("");
	});

	it("refuses an unmakeable directory on the universal 1 — never a path it could not allocate", async () => {
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
			Effect.provide(runScratch(options), Layer.merge(fakeSeams(CLAIMED).layer, unmakeable)),
		);
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("build scratch: cannot create ");
	});
});
