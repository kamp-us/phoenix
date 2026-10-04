/**
 * The shipped board's reads over a fake GitHub: the graph and the records come off batched GraphQL
 * requests, with REST spent only on comment lists and on an issue a batch could not prove whole.
 */
import {Effect, Layer} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {afterEach, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {fakeShell} from "../fakes.test-support.ts";
import {ISSUE_BATCH} from "../io/issue-batch.ts";
import {
	type FakeIssue,
	fakeIssues,
	GRAPHQL,
	REST_COMMENTS,
	REST_EDGES,
	REST_ISSUE,
} from "../io/issues-fake.test-support.ts";
import {NO_TARGET, PRECONDITION_UNKNOWN} from "./codes.ts";
import {readRecords, readScope, syncBoard} from "./sync-verb.ts";

beforeAll(() => {
	process.env.GITHUB_TOKEN = "ghp_scripted";
});
beforeEach(() => {
	process.env.FABRIKA_COMMENT_SCAN_DELAY_MS = "0";
});
afterEach(() => {
	delete process.env.FABRIKA_COMMENT_SCAN_DELAY_MS;
});

const REPO = "o/r";
const VERB = "table flags";

const on = (issues: Readonly<Record<number, FakeIssue>>, options = {}) => {
	const github = fakeIssues(issues, options);
	const layer = Layer.merge(github.layer, fakeShell([]).layer);
	const run = <A>(read: Effect.Effect<A, never, ChildProcessSpawner.ChildProcessSpawner>) =>
		Effect.runPromise(Effect.provide(read, layer));
	return {github, run};
};

const scopeOf = (issues: Readonly<Record<number, FakeIssue>>, seeds: ReadonlyArray<number>) => {
	const {github, run} = on(issues);
	return {github, read: run(readScope(syncBoard, VERB, REPO, seeds, new Set(seeds), new Set()))};
};

describe("the shipped board over a whole table", () => {
	const WIDE = 200;
	const numbers = Array.from({length: WIDE}, (_, index) => index + 1);

	it("reads 200 rows' graph and records with no REST issue or edge read, one comment list each", async () => {
		const {github, run} = on(
			Object.fromEntries(numbers.map((n) => [n, {comments: [`note on ${n}`]}])),
		);
		const rows = new Set(numbers);

		const scoped = await run(readScope(syncBoard, VERB, REPO, numbers, rows, new Set()));
		if (scoped._tag !== "Graph") throw new Error(scoped.reason);
		const read = await run(readRecords(syncBoard, VERB, REPO, scoped, rows));
		if (read._tag !== "Records") throw new Error(read.reason);

		expect(scoped.graph.size).toBe(WIDE);
		expect(read.records.size).toBe(WIDE);
		expect(github.count(REST_ISSUE)).toBe(0);
		expect(github.count(REST_EDGES)).toBe(0);
		expect(github.count(REST_COMMENTS)).toBe(WIDE);
		expect(github.count(GRAPHQL)).toBe(2 * Math.ceil(WIDE / ISSUE_BATCH));
	});

	it("reads each count after its issue's comment list", async () => {
		const {github, run} = on({1: {comments: ["a"]}, 2: {comments: ["b"]}});
		const rows = new Set([1, 2]);

		const scoped = await run(readScope(syncBoard, VERB, REPO, [1, 2], rows, new Set()));
		if (scoped._tag !== "Graph") throw new Error(scoped.reason);
		await run(readRecords(syncBoard, VERB, REPO, scoped, rows));

		const counted = github.log.findIndex((line) => line.startsWith("graphql counts"));
		const lists = github.log.flatMap((line, index) => (REST_COMMENTS.test(line) ? [index] : []));
		expect(lists).toHaveLength(2);
		expect(lists.every((index) => index < counted)).toBe(true);
	});

	it("refuses when a list stays shorter than its count after the bounded retries", async () => {
		process.env.FABRIKA_COMMENT_SCAN_ATTEMPTS = "3";
		const {github, run} = on({1: {comments: ["a", "b", "c"], listed: [1]}});
		const rows = new Set([1]);

		const scoped = await run(readScope(syncBoard, VERB, REPO, [1], rows, new Set()));
		if (scoped._tag !== "Graph") throw new Error(scoped.reason);
		const read = await run(readRecords(syncBoard, VERB, REPO, scoped, rows));
		delete process.env.FABRIKA_COMMENT_SCAN_ATTEMPTS;

		expect(read._tag).toBe("Refused");
		if (read._tag !== "Refused") return;
		expect(read.code).toBe(PRECONDITION_UNKNOWN);
		expect(read.reason).toContain("received 1 of 3 declared comment(s) after 3 read(s)");
		expect(github.count(REST_COMMENTS)).toBe(3);
		expect(github.count(REST_ISSUE)).toBe(0);
	});
});

describe("an issue a batch could not prove whole", () => {
	it("re-reads an issue whose sub-issues run past one page over REST, and only that one", async () => {
		const children = Array.from({length: 150}, (_, index) => 1000 + index);
		const {github, read} = scopeOf({1: {subIssues: children}, 2: {}}, [1, 2]);

		const scoped = await read;

		if (scoped._tag !== "Graph") throw new Error(scoped.reason);
		expect(scoped.graph.get(1)?.subIssues).toEqual(children);
		expect(github.count(REST_ISSUE)).toBe(1);
		expect(github.count(REST_EDGES)).toBe(3);
		expect(
			github.log.filter((line) => REST_EDGES.test(line)).every((l) => l.includes("/issues/1/")),
		).toBe(true);
	});

	it("re-reads an issue whose node alone errored over REST", async () => {
		const {github, read} = scopeOf(
			{1: {nodeError: "Resource not accessible", blockedBy: [2]}, 2: {}},
			[1, 2],
		);

		const scoped = await read;

		if (scoped._tag !== "Graph") throw new Error(scoped.reason);
		expect(scoped.graph.get(1)?.blockedBy).toEqual([2]);
		expect(github.count(REST_ISSUE)).toBe(1);
	});

	it("refuses PRECONDITION_UNKNOWN, writing nothing, when the batched request fails whole", async () => {
		const {github, run} = on({1: {}, 2: {}}, {graphqlStatus: 502});

		const scoped = await run(readScope(syncBoard, VERB, REPO, [1, 2], new Set([1, 2]), new Set()));

		expect(scoped._tag).toBe("Refused");
		if (scoped._tag !== "Refused") return;
		expect(scoped.code).toBe(PRECONDITION_UNKNOWN);
		expect(scoped.reason).toContain("Nothing was written.");
		expect(github.count(REST_ISSUE)).toBe(0);
	});
});

describe("a number that is no issue", () => {
	it("refuses a pull request seed NO_TARGET", async () => {
		const {read} = scopeOf({1: {}, 2: {pr: true}}, [1, 2]);

		const scoped = await read;

		expect(scoped._tag).toBe("Refused");
		if (scoped._tag !== "Refused") return;
		expect(scoped.code).toBe(NO_TARGET);
		expect(scoped.reason).toContain("has no issue #2 (a pull request is not a table row)");
	});

	it("reads a member that is no issue as a vanished node", async () => {
		const {read} = scopeOf({1: {subIssues: [7]}}, [1]);

		const scoped = await read;

		if (scoped._tag !== "Graph") throw new Error(scoped.reason);
		expect(scoped.graph.get(7)).toMatchObject({number: 7, open: false, subIssues: []});
	});
});
