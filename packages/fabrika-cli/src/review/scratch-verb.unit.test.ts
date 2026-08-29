import {Effect, FileSystem, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {type AuthoredSurface, leakRefusal} from "./authored.ts";
import {LEAKED_PATH, OFF_VOCABULARY} from "./codes.ts";
import {runScratch} from "./scratch-verb.ts";

const SHA = "03135b91aa1c4d6f8e2b7c9d0a1e3f5b7c9d0a1e";

const options = {
	pr: 4321,
	slug: "diff",
	lane: "4287",
	sha: SHA,
	env: {CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<string, string | undefined>,
	tmpRoot: "/scratch-root",
};

const run = (overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runScratch({...options, ...overrides}), fakeFs({}).layer));

describe("runScratch", () => {
	it("prints one absolute path under the group's own namespace", async () => {
		const out = await run();
		expect(out.code).toBe(0);
		expect(out.stdout).toMatch(
			/^\/scratch-root\/fabrika-review\/s-9f2e\/4321-[0-9a-f]{12}\/diff\n$/,
		);
	});

	/**
	 * The axis the incident turned on: a reviewer staged `diff.txt` in the session scratchpad and a
	 * concurrent lane replaced the bytes between two offset reads (#7246, live on PR #7232).
	 */
	it("resolves two lanes of ONE session to different directories", async () => {
		const first = await run({lane: "4287"});
		const second = await run({lane: "5830", pr: 4321, sha: SHA});
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(first.stdout).not.toBe(second.stdout);
	});

	/** Two rounds of one lane are two reviews of two trees, so round 2 must not read round 1's bytes. */
	it("resolves two rounds of ONE lane to different directories", async () => {
		const first = await run();
		const second = await run({sha: "9f2c1abbb3d4e5f60718293a4b5c6d7e8f901234"});
		expect(first.stdout).not.toBe(second.stdout);
	});

	it("resolves every call of one lane to the SAME directory", async () => {
		expect((await run({slug: "diff"})).stdout.replace(/diff\n$/, "")).toBe(
			(await run({slug: "notes"})).stdout.replace(/notes\n$/, ""),
		);
	});

	it("refuses a blank --lane on 1 rather than falling back to the session's directory", async () => {
		const out = await run({lane: "   "});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("--lane is blank");
	});

	it("refuses an unset session id on 1 — an unattributable session names no lane either", async () => {
		const out = await run({env: {}});
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("no session id is set");
	});

	it("refuses a session id that is not one path segment on 1", async () => {
		const out = await run({env: {CLAUDE_CODE_SESSION_ID: "s/9f2e"}});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("not one path segment");
	});

	it("refuses a slug carrying a path separator on 10", async () => {
		const out = await run({slug: "notes/inner"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			'review scratch: --slug "notes/inner" must be a kebab-case leaf, no path separators.',
		);
	});

	it("refuses a non-kebab slug on 10", async () => {
		expect((await run({slug: "Notes"})).code).toBe(OFF_VOCABULARY);
	});

	it("refuses a --sha that is not a head SHA on 10", async () => {
		const out = await run({sha: "not-a-sha"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("is not a head SHA");
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
		const out = await Effect.runPromise(Effect.provide(runScratch(options), unmakeable));
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("review scratch: cannot create ");
	});

	/**
	 * The path is machine-local, and the group's writing verbs already red on one — this pins that the
	 * shape THIS verb prints is inside that predicate rather than beside it.
	 */
	it("prints a path the group's writing verbs refuse in a body", async () => {
		const surface: AuthoredSurface = {
			verb: "review post",
			noun: "the assembled comment",
			emptyMessage: "empty",
			bareAtMessage: "bare @",
			leakCorrection: "cite it repo-relative or by class root.",
		};
		const path = (await run({tmpRoot: "/var/folders/kx"})).stdout.trim();
		const refusal = leakRefusal(surface, `PASS — staged the diff at ${path}`);
		expect(refusal?.code).toBe(LEAKED_PATH);
	});
});
