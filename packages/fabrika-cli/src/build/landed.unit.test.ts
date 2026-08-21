import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import {GATEWAY, GH_TOKEN_ENV, served} from "./fixtures.test-support.ts";
import {landedRefs, readAssembly} from "./landed.ts";

describe("landedRefs", () => {
	it("reads every issue a message names, subject and body alike", () => {
		expect([
			...landedRefs(["feat(guide): the front door (#6004)\n\nPart of #5817", "chore: nothing"]),
		]).toEqual([6004, 5817]);
	});

	it("is empty for a branch that carries no commit", () => {
		expect(landedRefs([]).size).toBe(0);
	});

	// The same rule `build commit` and `lane prove` read messages with, so a number written without
	// its `#` is not a reference — a discharge off "issue 210" would be a discharge off prose.
	it("does not read a bare number as a reference", () => {
		expect(landedRefs(["fix: closes issue 210"]).size).toBe(0);
	});
});

const TIP = "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567";
const BASE = "0123456789abcdef0123456789abcdef01234567";

const TRUNK = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;

const script: ReadonlyArray<Scripted> = [
	[/^git rev-parse --verify --quiet epic\/4300\^\{commit\}$/, okOut(`${TIP}\n`)],
	[TRUNK, served({default_branch: "main"})],
	[/^git merge-base origin\/main /, okOut(`${BASE}\n`)],
	[/^git log /, okOut(`${TIP}\x1ffeat: landed (#210)\x1e`)],
];

describe("readAssembly", () => {
	/**
	 * The bound is the finding this module was repaired for: a one-dot walk sweeps in the whole trunk
	 * history the assembly branch was cut from, and `issueRefsIn` matching a bare `#<n>` anywhere would
	 * then discharge an edge off a commit that predates the epic.
	 */
	it("walks only what the branch adds over its merge base with the trunk", async () => {
		const seams = fakeSeams(script);
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read).toMatchObject({_tag: "Read", branch: "epic/4300", baseRef: "origin/main"});
		expect(seams.calls.some((line) => line.endsWith(`${BASE}..${TIP}`))).toBe(true);
	});

	it("is Unreadable when the trunk cannot be named — never a partial discharge", async () => {
		const seams = fakeSeams([script[0] as Scripted, [TRUNK, GATEWAY]]);
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read._tag).toBe("Unreadable");
		expect(seams.calls.some((line) => line.startsWith("git log"))).toBe(false);
	});
});
