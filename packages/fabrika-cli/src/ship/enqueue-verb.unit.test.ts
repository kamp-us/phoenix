import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeSeams,
	type HttpReply,
	okOut,
	once,
	type Scripted,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	STALE_HEAD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runEnqueue} from "./enqueue-verb.ts";
import {ENV, HEAD, HEAD_REF, OTHER_HEAD, type PullShape, pull} from "./fixtures.test-support.ts";
import {ADDED} from "./queue.ts";

/** The base the replay lands on, and the head it produces — neither is any fixture's head. */
const BASE = "11aa22bb33cc44dd55ee66ff7788990011223344";
const REBASED = "5c1d7a08b39e4f6021c8ad57e93b0146fa2d8e7b";

/**
 * The live-head read and the mergeability read hit the same endpoint, so the first answer is
 * scripted `once` and every later one falls through to {@link MERGEABILITY}.
 */
const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;

/** The mergeability read is `./github.ts`'s, and hits the same endpoint over HTTP. */
const MERGEABILITY = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
/** The arm has no REST route: node-id read then `enablePullRequestAutoMerge`, both POSTed here. */
const GRAPHQL = /^POST \S+\/graphql$/;
const TIMELINE = /^GET \S+\/repos\/o\/r\/issues\/4321\/timeline\?/;

const mergeability = (shape: PullShape = {}): HttpReply => ({
	status: 200,
	body: pull(shape).stdout,
});

/** The verb's first read of the pull request — the live head it refuses drift on. */
const livePull = (shape: PullShape = {}): Scripted => [once(PULL), mergeability(shape)];

/** One body carrying both keys: each reader looks up only the key it needs. */
const ARMED: HttpReply = {
	status: 200,
	body: JSON.stringify({
		data: {
			repository: {pullRequest: {id: "PR_kwDOLxx1"}},
			enablePullRequestAutoMerge: {clientMutationId: null},
		},
	}),
};
const refused = (message: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({data: null, errors: [{message}]}),
});
const badGateway: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};
const timeline = (...rows: ReadonlyArray<{event: string; at: string}>): HttpReply => ({
	status: 200,
	body: JSON.stringify(rows.map((row) => ({event: row.event, created_at: row.at}))),
});

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

const both = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const seams = fakeSeams(script);
	return {
		seams,
		outcome: Effect.runPromise(Effect.provide(runEnqueue({...options, ...overrides}), seams.layer)),
	};
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	both(script, overrides).outcome;

describe("runEnqueue", () => {
	it("arms with NO merge-method flag and reports the visible entry", async () => {
		const scripted = both([
			livePull(),
			[MERGEABILITY, mergeability()],
			[GRAPHQL, ARMED],
			[TIMELINE, timeline({event: ADDED, at: "2026-08-08T10:00:00Z"})],
		]);
		const out = await scripted.outcome;
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`enqueued\t${HEAD}\tqueued\n`);
		const armed = scripted.seams.bodies.filter((body) =>
			body.includes("enablePullRequestAutoMerge"),
		);
		expect(armed).toHaveLength(1);
		expect(armed[0]).not.toContain("mergeMethod");
	});

	it("reports `settling` when the entry has not surfaced — the normal race, not a failure", async () => {
		const out = await run([
			livePull(),
			[MERGEABILITY, mergeability()],
			[GRAPHQL, ARMED],
			[TIMELINE, timeline()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`enqueued\t${HEAD}\tsettling\n`);
	});

	it("refuses a moved head on 12 — arming a tree nobody verified", async () => {
		const scripted = both([livePull({head: OTHER_HEAD})]);
		const out = await scripted.outcome;
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stdout).toBe("");
		expect(scripted.seams.requests.some((line) => /graphql/.test(line))).toBe(false);
	});

	it("refuses an already-merged PR on 7 — an idempotent success is `ship scope`'s answer", async () => {
		const out = await run([livePull({merged: true, state: "closed"})]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("ship enqueue: PR #4321 is merged — nothing to enqueue.");
	});

	it("refuses on 8 when the arm fails, quoting the error so the jam is discriminable", async () => {
		const out = await run([
			livePull(),
			[MERGEABILITY, mergeability()],
			[once(GRAPHQL), ARMED],
			[GRAPHQL, refused("Pull request is in unstable status")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(
			'the arm failed: "the GraphQL endpoint refused: Pull request is in unstable status"',
		);
		expect(out.stderr.at(-1)).toContain("disarm before stopping");
	});

	// Probed live: GitHub ACCEPTS the arm on a conflicted PR under a queue-governed base and parks the
	// intent, so nothing but this precondition stands between `dirty` and a parked intent reported as
	// a healthy enqueue.
	it("refuses on 11 when mergeability stays indefinite — an unknown read is never green", async () => {
		const scripted = both([
			livePull(),
			[MERGEABILITY, mergeability({mergeable: null, mergeableState: "unknown"})],
		]);
		const out = await scripted.outcome;
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"ship enqueue: #4321's mergeable_state is still indefinite after 3 polls — mergeability is UNKNOWN, never green; nothing was armed.",
		);
		expect(scripted.seams.requests.some((line) => /graphql/.test(line))).toBe(false);
	}, 20_000);

	it("refuses on 16 on a definite not-mergeable read that is not dirty (#6902)", async () => {
		const scripted = both([
			livePull(),
			[MERGEABILITY, mergeability({mergeable: false, mergeableState: "blocked"})],
		]);
		const out = await scripted.outcome;
		expect(out.code).toBe(PROVEN_NOT_IN_STATE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"ship enqueue: #4321 is not mergeable (mergeable_state: blocked) — a definite read; nothing was armed.",
		);
		expect(scripted.seams.requests.some((line) => /graphql/.test(line))).toBe(false);
		expect(scripted.seams.calls.some((line) => /rebase/.test(line))).toBe(false);
	});

	it("refuses on 11 when the mergeability read itself fails — nothing was armed", async () => {
		const scripted = both([livePull(), [MERGEABILITY, badGateway]]);
		const out = await scripted.outcome;
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read #4321's mergeability");
		expect(scripted.seams.requests.some((line) => /graphql/.test(line))).toBe(false);
	});

	it("refuses on 8 when the confirming read-back fails", async () => {
		const out = await run([
			livePull(),
			[MERGEABILITY, mergeability()],
			[GRAPHQL, ARMED],
			[TIMELINE, badGateway],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the confirming read-back failed");
	});

	/**
	 * A `dirty` read is a fact about the base, and the whole round now stays inside the verb.
	 * The three cases below are the split: a replay that applies, one that does not, and a branch the
	 * queue already holds. The fourth — a definite not-mergeable state that is not `dirty` — is the
	 * `blocked` case above, which must keep behaving exactly as it did.
	 */
	describe("a definite dirty read", () => {
		const dirty = mergeability({mergeable: false, mergeableState: "dirty"});

		/** The live head, the pre-arm mergeability and the head-branch read all hit the same URL. */
		const dirtyReads = (): ReadonlyArray<Scripted> => [
			[once(PULL), dirty],
			[once(PULL), dirty],
			[once(PULL), dirty],
		];

		const rebaseSeam = (replay: ExecResult = okOut("")): ReadonlyArray<Scripted> => [
			[/^git remote -v$/, okOut("origin\tgit@github.com:o/r.git (fetch)")],
			[/^git remote$/, okOut("origin")],
			[/^git fetch --quiet origin \S+$/, okOut("")],
			[/^git rev-parse --verify --quiet origin\/main/, okOut(BASE)],
			[new RegExp(`^git rev-parse --verify --quiet ${HEAD}`), okOut(HEAD)],
			[/^git rev-parse --git-common-dir$/, okOut(".git")],
			[/worktree add --detach/, okOut("")],
			[/ rebase --abort$/, okOut("")],
			[new RegExp(` rebase ${BASE}$`), replay],
			[/^git -C \S+ rev-parse HEAD$/, okOut(REBASED)],
			[/push --force-with-lease=/, okOut("")],
			[/^git ls-remote origin /, okOut(`${REBASED}\trefs/heads/${HEAD_REF}`)],
			[/^git worktree remove /, okOut("")],
		];

		it("rebases, republishes and enqueues the replay — no ROUTED-REPAIR, no retry spent", async () => {
			const scripted = both([
				...dirtyReads(),
				[PULL, mergeability({mergeableState: "clean"})],
				[GRAPHQL, ARMED],
				[TIMELINE, timeline({event: ADDED, at: "2026-09-10T10:00:00Z"})],
				...rebaseSeam(),
			]);
			const out = await scripted.outcome;
			expect(out.code).toBe(0);
			expect(out.stdout).toBe(`enqueued\t${REBASED}\tqueued\n`);
			expect(
				scripted.seams.calls.some((line) =>
					line.includes(`push --force-with-lease=${HEAD_REF}:${HEAD}`),
				),
			).toBe(true);
			expect(out.stderr.join("\n")).toContain("owes no new review round");
		});

		it("routes a replay that cannot apply to repair on 16 — resolving hunks changes content", async () => {
			const scripted = both([
				...dirtyReads(),
				...rebaseSeam(errOut("CONFLICT (content): Merge conflict in packages/x.ts")),
			]);
			const out = await scripted.outcome;
			expect(out.code).toBe(PROVEN_NOT_IN_STATE);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain("cannot replay onto origin/main");
			expect(scripted.seams.calls.some((line) => /rebase --abort/.test(line))).toBe(true);
			expect(scripted.seams.calls.some((line) => /push/.test(line))).toBe(false);
			expect(scripted.seams.requests.some((line) => /graphql/.test(line))).toBe(false);
		});

		it("never rewrites a branch a merge intent is already parked on", async () => {
			const parked = mergeability({mergeable: false, mergeableState: "dirty", autoMerge: true});
			const scripted = both([[once(PULL), parked], [PULL, parked], ...rebaseSeam()]);
			const out = await scripted.outcome;
			expect(out.code).toBe(PROVEN_NOT_IN_STATE);
			expect(out.stderr.at(-1)).toContain("a branch the queue holds");
			expect(scripted.seams.calls).toEqual([]);
		});
	});
});
