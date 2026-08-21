import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	NO_LANDING_METHOD,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	STALE_HEAD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	branchRules,
	ENV,
	HEAD,
	MERGE_COMMIT,
	mergeProofServed,
	OTHER_HEAD,
	type PullShape,
	pull,
	repositoryServed,
} from "./fixtures.test-support.ts";
import {runMerge} from "./merge-verb.ts";

/**
 * Three legs read the pull request and they all read the same endpoint: the live head, then
 * mergeability, then the landing proof. `once` is what keeps their answers distinguishable.
 */
const PULL = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4321$/;
const RULES = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/rules\/branches\/main$/;
const REPO = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;
const MERGE = /^PUT https:\/\/api\.github\.com\/repos\/o\/r\/pulls\/4321\/merge$/;

/** A canned `ExecResult` fixture as the body of a 200 — the same payload, off the served seam. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const UNQUEUED: Scripted = [RULES, served(branchRules("pull_request"))];
const MERGED: Scripted = [MERGE, {status: 200, body: "{}"}];

/** The verb's first read of the pull request — the live head it refuses drift on. */
const livePull = (shape: PullShape = {}): Scripted => [once(PULL), served(pull(shape))];

/** The mergeability poll, which reads the same endpoint one request later. */
const mergeabilityRead = (shape: PullShape = {}): Scripted => [once(PULL), served(pull(shape))];

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

const land = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(Effect.provide(runMerge({...options, ...overrides}), seams.layer)).then(
		(outcome) => ({outcome, calls: seams.requests, bodies: seams.bodies}),
	);
};

/** Every read the happy path makes, in the order the verb makes them. */
const happyReads = (): ReadonlyArray<Scripted> => [
	livePull(),
	mergeabilityRead(),
	UNQUEUED,
	[REPO, repositoryServed()],
];

const withoutWrite = (calls: ReadonlyArray<string>): boolean =>
	calls.every((line) => !line.startsWith("PUT "));

describe("runMerge", () => {
	it("lands on an unqueued base with the repo's preferred method and proves the commit", async () => {
		const {outcome, calls, bodies} = await land([
			...happyReads(),
			MERGED,
			[PULL, mergeProofServed()],
		]);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`merged\t${MERGE_COMMIT}\tsquash\n`);
		const at = calls.findIndex((line) => line.startsWith("PUT "));
		expect(calls[at]).toBe("PUT https://api.github.com/repos/o/r/pulls/4321/merge");
		expect(JSON.parse(bodies[at] as string)).toEqual({sha: HEAD, merge_method: "squash"});
	});

	it("hands the platform the FULL live head, not the caller's abbreviation", async () => {
		const {calls, bodies} = await land([...happyReads(), MERGED, [PULL, mergeProofServed()]], {
			sha: HEAD.slice(0, 8),
		});
		const at = calls.findIndex((line) => line.startsWith("PUT "));
		expect(JSON.parse(bodies[at] as string).sha).toBe(HEAD);
	});

	it("falls to the merge commit when the repository has squash disabled", async () => {
		const {outcome} = await land([
			livePull(),
			mergeabilityRead(),
			UNQUEUED,
			[REPO, repositoryServed({squash: false})],
			MERGED,
			[PULL, mergeProofServed()],
		]);
		expect(outcome.stdout).toBe(`merged\t${MERGE_COMMIT}\tmerge\n`);
	});

	it("refuses on 16 when a merge queue governs the base, and points at `ship enqueue`", async () => {
		const {outcome, calls} = await land([livePull(), [RULES, served(branchRules("merge_queue"))]]);
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(outcome.stderr.at(-1)).toBe(
			"ship merge: a merge queue governs main — the queue owns the method and the landing; run `fabrika ship enqueue` instead.",
		);
		expect(withoutWrite(calls)).toBe(true);
	});

	it("refuses on 19 when the repository permits no merge method — never guessing one", async () => {
		const {outcome, calls} = await land([
			livePull(),
			[RULES, {status: 200, body: "[]"}],
			[REPO, repositoryServed({squash: false, merge: false, rebase: false})],
		]);
		expect(outcome.code).toBe(NO_LANDING_METHOD);
		expect(outcome.stderr.at(-1)).toContain("permits no merge method");
		expect(withoutWrite(calls)).toBe(true);
	});

	it("refuses on 11 when the landing path cannot be read — never landing on an unread regime", async () => {
		const {outcome, calls} = await land([
			livePull(),
			[RULES, {status: 503, body: '{"message":"unavailable"}'}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("cannot read main's landing path");
		expect(withoutWrite(calls)).toBe(true);
	});

	it("refuses on 11 when mergeability stays indefinite — an unknown read is never green", async () => {
		const {outcome, calls} = await land([
			livePull(),
			UNQUEUED,
			[REPO, repositoryServed()],
			[PULL, served(pull({mergeable: null, mergeableState: "unknown"}))],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toBe(
			"ship merge: #4321's mergeable_state is still indefinite after 3 polls — mergeability is UNKNOWN, never green; nothing was merged.",
		);
		expect(withoutWrite(calls)).toBe(true);
	}, 20_000);

	it("refuses on 16 on a definite `dirty` — the endpoint would reject it indistinguishably", async () => {
		const {outcome, calls} = await land([
			livePull(),
			UNQUEUED,
			[REPO, repositoryServed()],
			[PULL, served(pull({mergeable: false, mergeableState: "dirty"}))],
		]);
		expect(outcome.code).toBe(PROVEN_NOT_IN_STATE);
		expect(outcome.stderr.at(-1)).toBe(
			"ship merge: #4321 is not mergeable (mergeable_state: dirty) — a definite read; nothing was merged.",
		);
		expect(withoutWrite(calls)).toBe(true);
	});

	it("refuses on 12 when the live head moved past --sha", async () => {
		const {outcome, calls} = await land([livePull({head: OTHER_HEAD})]);
		expect(outcome.code).toBe(STALE_HEAD);
		expect(outcome.stderr.at(-1)).toContain("refusing to merge a tree nobody verified");
		expect(withoutWrite(calls)).toBe(true);
	});

	it("refuses an already-merged PR on 7 — an idempotent success is `ship scope`'s answer", async () => {
		const {outcome} = await land([livePull({merged: true, state: "closed"})]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toBe("ship merge: PR #4321 is merged — nothing to merge.");
	});

	it("refuses on 8 when the merge call fails, quoting the status", async () => {
		const {outcome} = await land([
			...happyReads(),
			[MERGE, {status: 405, body: '{"message":"Pull Request is not mergeable"}'}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain('the merge failed: "GitHub answered HTTP 405"');
	});

	it("refuses on 8 when the confirming read-back fails — the landing is UNKNOWN", async () => {
		const {outcome} = await land([
			...happyReads(),
			MERGED,
			[PULL, {status: 503, body: '{"message":"unavailable"}'}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("the confirming read-back failed");
	});

	it("refuses on 9 when the read-back names no merge commit — a claim is not evidence", async () => {
		const {outcome} = await land([...happyReads(), MERGED, [PULL, mergeProofServed({commit: ""})]]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.at(-1)).toContain("the landing is not proven");
	});

	it("refuses on 9 when the read-back shows the PR is still not merged", async () => {
		const {outcome} = await land([
			...happyReads(),
			MERGED,
			[PULL, mergeProofServed({merged: false})],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.at(-1)).toContain("merged: false");
	});

	it("refuses on 8 when the read-back names no merge state at all — never reading it unmerged", async () => {
		const {outcome} = await land([
			...happyReads(),
			MERGED,
			[PULL, {status: 200, body: '{"number":4321}'}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("the confirming read-back failed");
	});

	it("emits the landing object under --json", async () => {
		const {outcome} = await land([...happyReads(), MERGED, [PULL, mergeProofServed()]], {
			json: true,
		});
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "merged",
			sha: HEAD,
			method: "squash",
			mergeCommit: MERGE_COMMIT,
		});
	});
});
