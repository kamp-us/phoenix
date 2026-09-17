import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeShell, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNREACHABLE_TIP,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {runSeat} from "./seat-verb.ts";

const TIP = "4011b1d8238aaf1d71de8704bedb1aa1dd98fda9";
const BASE = "99b145346624d50b12c93309c9f566cce40cc8f2";
/** Where an unseated reviewer stands: neither end of the range — the shape the incident had. */
const ELSEWHERE = "cb5e76a3f2b1c4d5e6f708192a3b4c5d6e7f8091";
const BRANCH = "build/8820-seat-the-tree-9f2e1a4b";

const BRANCHES = /^git for-each-ref/;
const HEAD = () => once(/^git rev-parse --verify --quiet HEAD\^/);
const RESOLVE_TIP = new RegExp(`^git rev-parse --verify --quiet ${TIP}\\^`);
const RESOLVE_BRANCH = new RegExp(`^git rev-parse --verify --quiet ${BRANCH}\\^`);
const MERGE_BASE = /^git merge-base /;
const SWITCH = /^git switch --detach /;

type Row = readonly [RegExp, ExecResult];

/** Every diagnostic line the verb emitted, joined — what a caller reads on stderr. */
const shellSaid = (stderr: ReadonlyArray<string>): string => stderr.join("\n");

const options: {issue: number; base: string | null; tip: string | null; json: boolean} = {
	issue: 8820,
	base: BASE,
	tip: TIP,
	json: false,
};

const run = (shell: FakeShell, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runSeat({...options, ...overrides}), shell.layer));

/**
 * A tree holding the child's branch at the range tip, standing on each of `heads` in turn.
 *
 * The two HEAD reads are the point: the verb reads where the tree stands, seats it, and reads HEAD
 * back, so a script that answered both from one row could never tell a real read-back from its own
 * input.
 */
const tree = (heads: ReadonlyArray<string>, extra: ReadonlyArray<Row> = []): FakeShell =>
	fakeShell([
		...extra,
		...heads.map((sha): Row => [HEAD(), okOut(`${sha}\n`)]),
		[BRANCHES, okOut(`main\n${BRANCH}\nepic/8810\n`)],
		[RESOLVE_TIP, okOut(`${TIP}\n`)],
		[RESOLVE_BRANCH, okOut(`${TIP}\n`)],
		[MERGE_BASE, okOut(`${TIP}\n`)],
		[SWITCH, okOut("")],
	]);

describe("runSeat — the seated case", () => {
	it("checks the tree out at the range tip and reads HEAD back off git", async () => {
		const shell = tree([ELSEWHERE, TIP]);
		const out = await run(shell);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`seated\t${TIP}\t${BRANCH}\tchecked-out\n`);
		expect(shell.calls).toContain(`git switch --detach ${TIP}`);
	});

	it("seats detached — it never switches to or moves the child's branch", async () => {
		const shell = tree([ELSEWHERE, TIP]);
		await run(shell);
		expect(shell.calls.some((line) => /^git switch (?!--detach)/.test(line))).toBe(false);
		expect(shell.calls.some((line) => /^git branch /.test(line))).toBe(false);
	});

	it("names the range's carrier and the read-back head under --json", async () => {
		const out = await run(tree([ELSEWHERE, TIP]), {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "seated",
			issue: 8820,
			base: BASE,
			tip: TIP,
			head: TIP,
			branch: BRANCH,
			carriers: [BRANCH],
			action: "checked-out",
		});
	});
});

describe("runSeat — a re-run over an already-seated tree", () => {
	it("answers already-seated without a second checkout", async () => {
		const shell = tree([TIP, TIP]);
		const out = await run(shell);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`seated\t${TIP}\t${BRANCH}\talready-seated\n`);
		expect(shell.calls.some((line) => SWITCH.test(line))).toBe(false);
	});
});

describe("runSeat — the unreachable tip", () => {
	it("refuses when this clone holds no lane branch for the child, naming the range", async () => {
		const out = await run(fakeShell([[BRANCHES, okOut("main\nepic/8810\n")]]));
		expect(out.code).toBe(UNREACHABLE_TIP);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("build/8820-<slug>-<nonce>");
		expect(shellSaid(out.stderr)).toContain(`${BASE}..${TIP}`);
	});

	it("refuses when the tip resolves to no object here — never a seat in place", async () => {
		const shell = fakeShell([
			[BRANCHES, okOut(`main\n${BRANCH}\n`)],
			[RESOLVE_TIP, errOut("")],
		]);
		const out = await run(shell);
		expect(out.code).toBe(UNREACHABLE_TIP);
		expect(shellSaid(out.stderr)).toContain(`${BASE}..${TIP}`);
		expect(shell.calls.some((line) => SWITCH.test(line))).toBe(false);
	});

	it("refuses when no lane branch of the child reaches the tip", async () => {
		const shell = fakeShell([
			[BRANCHES, okOut(`main\n${BRANCH}\n`)],
			[RESOLVE_TIP, okOut(`${TIP}\n`)],
			[RESOLVE_BRANCH, okOut(`${ELSEWHERE}\n`)],
			[MERGE_BASE, okOut(`${BASE}\n`)],
		]);
		const out = await run(shell);
		expect(out.code).toBe(UNREACHABLE_TIP);
		expect(shellSaid(out.stderr)).toContain(BRANCH);
		expect(shell.calls.some((line) => SWITCH.test(line))).toBe(false);
	});
});

describe("runSeat — the reads that are UNKNOWN, never a seat", () => {
	it("refuses at 11 when the branch list cannot be read", async () => {
		const out = await run(fakeShell([[BRANCHES, errOut("git died")]]));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shellSaid(out.stderr)).toContain("UNKNOWN");
	});

	it("refuses at 11 when containment cannot be read — never 'not carried'", async () => {
		const out = await run(
			fakeShell([
				[BRANCHES, okOut(`main\n${BRANCH}\n`)],
				[RESOLVE_TIP, okOut(`${TIP}\n`)],
				[RESOLVE_BRANCH, okOut(`${TIP}\n`)],
				[MERGE_BASE, errOut("bad object")],
			]),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses at 8 when the checkout itself fails, naming where the tree stood", async () => {
		const out = await run(
			tree([ELSEWHERE, TIP], [[SWITCH, errOut("local changes would be overwritten")]]),
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(shellSaid(out.stderr)).toContain(ELSEWHERE);
	});

	it("refuses at 9 when the checkout reports success and HEAD reads elsewhere", async () => {
		const out = await run(tree([ELSEWHERE, ELSEWHERE]));
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(shellSaid(out.stderr)).toContain(ELSEWHERE);
	});
});

describe("runSeat — the operands", () => {
	it("refuses a range with one end", async () => {
		const out = await run(fakeShell([]), {tip: null});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a run with no range at all — there is no PR here to resolve one from", async () => {
		const out = await run(fakeShell([]), {base: null, tip: null});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(shellSaid(out.stderr)).toContain("--base and --tip are required");
	});

	it("refuses a positional that is not an issue number", async () => {
		const out = await run(fakeShell([]), {issue: 0});
		expect(out.code).toBe(1);
	});
});
