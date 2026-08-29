import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type HttpReply, okOut, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {readDischargedGate} from "./discharge.ts";
import {GATEWAY, GH_TOKEN_ENV, issue, NOT_FOUND, served} from "./fixtures.test-support.ts";

const CHILD = 7030;
const BLOCKER_NUMBER = 7029;
const EPIC = 6767;

const EDGES = new RegExp(`^GET \\S+/repos/o/r/issues/${CHILD}/dependencies/blocked_by`);
const PARENT = new RegExp(`^GET \\S+/repos/o/r/issues/${CHILD}/parent$`);
const BLOCKER = new RegExp(`^GET \\S+/repos/o/r/issues/${BLOCKER_NUMBER}$`);
const ASSEMBLY = new RegExp(`^git rev-parse --verify --quiet epic/${EPIC}\\^\\{commit\\}$`);
const TRUNK = /^GET \S+\/repos\/o\/r$/;
const MERGE_BASE = /^git merge-base origin\/main [0-9a-f]{40}$/;
const ASSEMBLY_LOG = /^git log --format=.* [0-9a-f]{40}\.\.[0-9a-f]{40}$/;

const TIP = "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567";
const BASE = "0123456789abcdef0123456789abcdef01234567";

const edges = (...numbers: ReadonlyArray<number>): HttpReply =>
	served(numbers.map((number) => ({number, state: "open"})));

/** The three reads that bound the assembly range — tip, trunk, merge base. */
const RANGE_ENDPOINTS: ReadonlyArray<Scripted> = [
	[ASSEMBLY, okOut(`${TIP}\n`)],
	[TRUNK, served({default_branch: "main"})],
	[MERGE_BASE, okOut(`${BASE}\n`)],
];

/** One `git log` record stream, in the framing `rangeCommits` reads. */
const commitLog = (...messages: ReadonlyArray<string>): ExecResult =>
	okOut(messages.map((message, i) => `${TIP.slice(0, 39)}${i}\x1f${message}\x1e`).join(""));

const env = {CLAUDE_PIPELINE_REPO: "o/r", ...GH_TOKEN_ENV} as Record<string, string | undefined>;

const run = async (script: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams(script);
	const out = await Effect.runPromise(
		Effect.provide(readDischargedGate("build claim", env, "o/r", CHILD), seams.layer),
	);
	return {out, calls: seams.calls, requests: seams.requests};
};

/** The child's edge names an open blocker — the board's own answer, before any discharge. */
const OPEN_EDGE: ReadonlyArray<Scripted> = [
	[EDGES, edges(BLOCKER_NUMBER)],
	[BLOCKER, issue({number: BLOCKER_NUMBER, state: "open"})],
];

describe("readDischargedGate", () => {
	it("clears an edge whose blocker's work landed on the epic run's assembly branch", async () => {
		const {out} = await run([
			...OPEN_EDGE,
			[PARENT, served({number: EPIC})],
			...RANGE_ENDPOINTS,
			[ASSEMBLY_LOG, commitLog(`feat(tracer): the first tracer (#${BLOCKER_NUMBER})`)],
		]);
		expect(out.gate).toEqual({_tag: "Clear", scanned: 1});
		expect(out.notes.join("\n")).toContain(`adds a commit naming #${BLOCKER_NUMBER}`);
	});

	it("still blocks an open edge the branch does not carry — discharge only ever admits", async () => {
		const {out} = await run([
			...OPEN_EDGE,
			[PARENT, served({number: EPIC})],
			...RANGE_ENDPOINTS,
			[ASSEMBLY_LOG, commitLog("chore(epic): assembly branch cut (#6768)")],
		]);
		expect(out.gate).toEqual({_tag: "Blocked", scanned: 1, open: [BLOCKER_NUMBER]});
		expect(out.notes.join("\n")).toContain("none naming an undischarged blocker");
	});

	it("keeps the board's state when the assembly branch cannot be read", async () => {
		const {out} = await run([
			...OPEN_EDGE,
			[PARENT, served({number: EPIC})],
			[ASSEMBLY, errOut(`fatal: ambiguous argument 'epic/${EPIC}'`)],
		]);
		expect(out.gate).toEqual({_tag: "Blocked", scanned: 1, open: [BLOCKER_NUMBER]});
		expect(out.notes.join("\n")).toContain(`cannot read epic/${EPIC} in this tree`);
	});

	it("reads no branch for a standalone issue — its blockers land nowhere derivable", async () => {
		const {out, calls} = await run([...OPEN_EDGE, [PARENT, NOT_FOUND]]);
		expect(out.gate).toEqual({_tag: "Blocked", scanned: 1, open: [BLOCKER_NUMBER]});
		expect(out.notes).toEqual([]);
		expect(calls.some((line) => /rev-parse/.test(line))).toBe(false);
	});

	it("resolves no parent at all when the board already reads the issue clear", async () => {
		const {out, requests} = await run([
			[EDGES, edges(BLOCKER_NUMBER)],
			[BLOCKER, issue({number: BLOCKER_NUMBER, state: "closed"})],
		]);
		expect(out.gate).toEqual({_tag: "Clear", scanned: 1});
		expect(requests.some((line) => PARENT.test(line))).toBe(false);
	});

	it('is UNKNOWN when the parent could not be read — never "not blocked", never blocked on unread evidence', async () => {
		const {out} = await run([...OPEN_EDGE, [PARENT, GATEWAY]]);
		expect(out.gate._tag).toBe("Unknown");
		expect(out.gate._tag === "Unknown" && out.gate.reason).toContain(`the parent of #${CHILD}`);
	});

	it("is UNKNOWN when the edge list could not be read", async () => {
		const {out} = await run([[EDGES, GATEWAY]]);
		expect(out.gate._tag).toBe("Unknown");
	});

	it("discharges an unread blocker the branch carries — the landed commit outranks the failed read", async () => {
		const {out} = await run([
			[EDGES, edges(BLOCKER_NUMBER)],
			[BLOCKER, GATEWAY],
			[PARENT, served({number: EPIC})],
			...RANGE_ENDPOINTS,
			[ASSEMBLY_LOG, commitLog(`feat(tracer): the first tracer (#${BLOCKER_NUMBER})`)],
		]);
		expect(out.gate).toEqual({_tag: "Clear", scanned: 1});
	});
});
