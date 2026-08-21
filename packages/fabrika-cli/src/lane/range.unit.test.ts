import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {locateRange} from "./range.ts";

const EPIC = 5631;
const CHILD = 6292;
const CHILD_BRANCH = "build/6292-a-slug-4bca08ba";

/** A 40-hex object name from a short seed, so a fixture SHA reads as the thing it stands for. */
const sha = (seed: string): string => seed.repeat(40).slice(0, 40);

const EPIC_TIP = sha("32e51906");
const FORK = sha("ef475457");
const CHILD_TIP = sha("8d658f78");

const literally = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const REV = (rev: string) =>
	new RegExp(`^git rev-parse --verify --quiet ${literally(rev)}\\^\\{commit\\}$`);
const SHALLOW = /^git rev-parse --is-shallow-repository$/;
const BRANCHES = /^git for-each-ref --format=%\(refname:short\) refs\/heads$/;
const PARENTS = (of: string) => new RegExp(`^git log -1 --format=%P ${of}$`);
const MERGE_BASE = /^git merge-base /;
const LOG_RANGE = /^git log --format=/;

type Scripted = readonly [RegExp, ExecResult];

/** `git log`'s framing for one commit: `<sha>\x1f<message>\x1e`. */
const logOf = (...rows: ReadonlyArray<readonly [string, string]>): ExecResult =>
	okOut(rows.map(([commit, message]) => `${commit}\x1f${message}\n\x1e`).join(""));

const RANGE: Scripted[] = [
	[REV(`epic/${EPIC}`), okOut(`${EPIC_TIP}\n`)],
	[BRANCHES, okOut(`${CHILD_BRANCH}\nmain\nepic/${EPIC}\n`)],
	[REV(CHILD_BRANCH), okOut(`${CHILD_TIP}\n`)],
	[MERGE_BASE, okOut(`${FORK}\n`)],
	[LOG_RANGE, logOf([CHILD_TIP, `fix(lane): guard the range (#${CHILD})`])],
];

const run = (script: ReadonlyArray<Scripted>) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.map(
			Effect.provide(locateRange("fabrika lane brief", EPIC, CHILD), shell.layer),
			(located) => ({located, calls: shell.calls}),
		),
	);
};

describe("locateRange on a shallow clone", () => {
	it("answers the range when the clone is complete, without asking any commit for its parents", async () => {
		const {located, calls} = await run([[SHALLOW, okOut("false\n")], ...RANGE]);
		expect(located._tag).toBe("Located");
		if (located._tag !== "Located") return;
		expect(located.range).toMatchObject({base: FORK, tip: CHILD_TIP, commits: 1, naming: 1});
		expect(calls.some((line) => line.startsWith("git log -1 --format=%P"))).toBe(false);
	});

	it("answers the range when the boundary touches neither the assembly tip nor the fork point", async () => {
		const {located} = await run([
			[SHALLOW, okOut("true\n")],
			[PARENTS(EPIC_TIP), okOut(`${sha("aaaaaaaa")} ${sha("bbbbbbbb")}\n`)],
			[PARENTS(FORK), okOut(`${sha("cccccccc")}\n`)],
			...RANGE,
		]);
		expect(located._tag).toBe("Located");
		if (located._tag !== "Located") return;
		expect(located.range.commits).toBe(1);
	});

	it("refuses before reading a branch when the assembly tip is the graft boundary", async () => {
		const {located, calls} = await run([
			[SHALLOW, okOut("true\n")],
			[PARENTS(EPIC_TIP), okOut("\n")],
			...RANGE,
		]);
		expect(located).toEqual({_tag: "Truncated", what: `epic/${EPIC}'s tip`, sha: EPIC_TIP});
		expect(calls.some((line) => line.startsWith("git for-each-ref"))).toBe(false);
	});

	it("refuses when the fork point is the graft boundary, naming the commit and the branch", async () => {
		const {located, calls} = await run([
			[SHALLOW, okOut("true\n")],
			[PARENTS(EPIC_TIP), okOut(`${sha("aaaaaaaa")}\n`)],
			[PARENTS(FORK), okOut("\n")],
			...RANGE,
		]);
		expect(located).toEqual({
			_tag: "Truncated",
			what: `where "${CHILD_BRANCH}" forked from epic/${EPIC}`,
			sha: FORK,
		});
		expect(calls.some((line) => line.startsWith("git log --format="))).toBe(false);
	});

	it("calls an unreadable shallow probe UNKNOWN rather than a complete clone", async () => {
		const {located} = await run(RANGE);
		expect(located._tag).toBe("Unreadable");
		if (located._tag !== "Unreadable") return;
		expect(located.what).toBe("whether this clone is shallow");
	});

	it("calls an unreadable parent list UNKNOWN rather than a boundary", async () => {
		const {located} = await run([[SHALLOW, okOut("true\n")], ...RANGE]);
		expect(located).toMatchObject({
			_tag: "Unreadable",
			what: `this clone's graft boundary at ${EPIC_TIP}`,
		});
	});
});
