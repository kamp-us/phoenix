import {Effect, FileSystem, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {OFF_VOCABULARY} from "./codes.ts";
import {runScratch} from "./scratch-verb.ts";

const SESSION = "s-9f2e";

const options = {
	pr: 4321,
	slug: "note",
	env: {CLAUDE_CODE_SESSION_ID: SESSION} as Record<string, string | undefined>,
	tmpRoot: "/scratch-root",
};

const run = (overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runScratch({...options, ...overrides}), fakeFs({}).layer));

describe("runScratch keys the namespace on the session and the PR", () => {
	it("prints the allocated leaf path", async () => {
		const out = await run();
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`/scratch-root/fabrika-heal-ci/${SESSION}/4321/note\n`);
	});

	/**
	 * The failure this verb exists to make unconstructible: two healers writing a fixed-name note body
	 * into one working directory clobbered each other mid-post (#7209/#7210).
	 */
	it("hands two concurrent healers two directories for one PR", async () => {
		const first = await run();
		const second = await run({env: {CLAUDE_CODE_SESSION_ID: "s-other"}});
		expect(first.stdout).not.toBe(second.stdout);
	});

	it("separates two rows of one sweep under one session", async () => {
		const first = await run({pr: 4321});
		const second = await run({pr: 4322});
		expect(first.stdout).not.toBe(second.stdout);
	});

	it("reads the session off the FABRIKA_SESSION_ID chain, first set wins", async () => {
		const out = await run({
			env: {FABRIKA_SESSION_ID: "s-ci", CLAUDE_CODE_SESSION_ID: SESSION},
		});
		expect(out.stdout).toBe("/scratch-root/fabrika-heal-ci/s-ci/4321/note\n");
	});
});

describe("runScratch refuses rather than allocating a path it cannot key", () => {
	it("refuses a slug carrying a path separator on 10", async () => {
		const out = await run({slug: "notes/inner"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
	});

	it("refuses a slug that is not kebab-case on 10", async () => {
		const out = await run({slug: "NoteBody"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses an unattributable session on 1", async () => {
		const out = await run({env: {}});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("no session id is set");
	});

	it("refuses a session id that is not one path segment", async () => {
		const out = await run({env: {CLAUDE_CODE_SESSION_ID: "a/b"}});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("one path segment");
	});

	it("refuses a non-PR positional on 1", async () => {
		const out = await run({pr: 0});
		expect(out.code).toBe(FAILED);
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
		const out = await Effect.runPromise(Effect.provide(runScratch(options), unmakeable));
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("heal-ci scratch: cannot create ");
	});
});
