import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {Shell} from "../io/git.ts";
import {
	commitsTouchingRange,
	lastCommitTouching,
	pathPresentAt,
	presentPathsAt,
	topLevelEntriesAt,
} from "./git.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";
const OTHER = "aa4712e0af2d9b6c35417e83c5b6d9a2f4e0c1b7";

const run = <A>(
	effect: Shell<A>,
	script: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, fakeShell(script).layer));

/**
 * The split the whole group rests on: `git ls-tree … -- <path>` exits `0` either way, so an empty
 * listing is a path that is NOT there and a non-zero exit is a read that failed. If these two ever
 * fused, `pattern corpus` would answer `absent` for a tree it could not read.
 */
describe("presence is a fact, and a failed read is not", () => {
	it("reads an empty listing as absent, at Ok rather than Failure", async () => {
		const out = await run(pathPresentAt(SHA, "no/such/dir"), [[/^git ls-tree/, okOut("")]]);
		expect(out).toEqual({_tag: "Ok", value: false});
	});

	it("reads the path echoed back as present", async () => {
		const out = await run(pathPresentAt(SHA, ".patterns"), [
			[/^git ls-tree/, okOut(".patterns\n")],
		]);
		expect(out).toEqual({_tag: "Ok", value: true});
	});

	it("reads a non-zero exit as a FAILURE, never as absence", async () => {
		const out = await run(pathPresentAt(SHA, ".patterns"), [
			[/^git ls-tree/, errOut("fatal: not a tree object")],
		]);
		expect(out).toMatchObject({_tag: "Failure"});
	});

	// An empty pathspec list would make `git ls-tree <sha> --` list the whole root tree, which would
	// report every top-level entry as a resolved citation.
	it("spawns nothing for an empty path set", async () => {
		const shell = fakeShell([]);
		const out = await Effect.runPromise(Effect.provide(presentPathsAt(SHA, []), shell.layer));
		expect(out).toEqual({_tag: "Ok", value: new Set()});
		expect(shell.calls).toEqual([]);
	});

	it("returns the resolved subset of a mixed set", async () => {
		const out = await run(presentPathsAt(SHA, ["apps/a.ts", "gone/b.ts"]), [
			[/^git ls-tree/, okOut("apps/a.ts\n")],
		]);
		expect(out).toEqual({_tag: "Ok", value: new Set(["apps/a.ts"])});
	});
});

describe("history reads", () => {
	it("parses the sha and the author date off one log line", async () => {
		const out = await run(lastCommitTouching(SHA, ".patterns/a.md"), [
			[/^git log/, okOut(`${OTHER}\t2026-08-01\n`)],
		]);
		expect(out).toEqual({_tag: "Ok", value: {sha: OTHER, date: "2026-08-01"}});
	});

	// A path with no commit at or before the base is a fact the caller decides on; it is not a
	// failure, and it is not a commit.
	it("answers null for a path no commit touches, and Failure for a read that broke", async () => {
		expect(await run(lastCommitTouching(SHA, "x"), [[/^git log/, okOut("")]])).toEqual({
			_tag: "Ok",
			value: null,
		});
		expect(
			await run(lastCommitTouching(SHA, "x"), [[/^git log/, errOut("fatal: bad revision")]]),
		).toMatchObject({_tag: "Failure"});
	});

	it("counts every commit in the range, newest first", async () => {
		const out = await run(commitsTouchingRange(OTHER, SHA, "apps/a.ts"), [
			[/^git log/, okOut(`${SHA}\t2026-08-05\n${OTHER}\t2026-08-01\n`)],
		]);
		expect(out).toEqual({
			_tag: "Ok",
			value: [
				{sha: SHA, date: "2026-08-05"},
				{sha: OTHER, date: "2026-08-01"},
			],
		});
	});

	it("drops a log line that does not carry both fields rather than half-reading it", async () => {
		const out = await run(commitsTouchingRange(OTHER, SHA, "apps/a.ts"), [
			[/^git log/, okOut("just-a-sha\n")],
		]);
		expect(out).toEqual({_tag: "Ok", value: []});
	});
});

describe("topLevelEntriesAt", () => {
	it("reads the root tree's entries as the segment set a cited path must open with", async () => {
		const out = await run(topLevelEntriesAt(SHA), [
			[/^git ls-tree/, okOut("apps\npackages\nREADME.md\n")],
		]);
		expect(out).toEqual({_tag: "Ok", value: new Set(["apps", "packages", "README.md"])});
	});
});
