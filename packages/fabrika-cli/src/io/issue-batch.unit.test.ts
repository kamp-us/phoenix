import {Effect, Layer} from "effect";
import {afterEach, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {fakeShell} from "../fakes.test-support.ts";
import {ok} from "./git.ts";
import {
	type CommentWaveReads,
	ISSUE_BATCH,
	readCommentCounts,
	readIssueNodes,
	reconcileComments,
} from "./issue-batch.ts";
import {type CommentRecord, present} from "./issues.ts";
import {type FakeIssue, fakeIssues, GRAPHQL} from "./issues-fake.test-support.ts";

beforeAll(() => {
	process.env.GITHUB_TOKEN = "ghp_scripted";
});

const REPO = "o/r";

const against = (
	issues: Readonly<Record<number, FakeIssue>>,
	options: Parameters<typeof fakeIssues>[1] = {},
) => {
	const github = fakeIssues(issues, options);
	const layer = Layer.merge(github.layer, fakeShell([]).layer);
	return {
		github,
		nodes: (numbers: ReadonlyArray<number>) =>
			Effect.runPromise(Effect.provide(readIssueNodes(REPO, numbers), layer)),
		counts: (numbers: ReadonlyArray<number>) =>
			Effect.runPromise(Effect.provide(readCommentCounts(REPO, numbers), layer)),
	};
};

describe("readIssueNodes", () => {
	it(`reads 200 issues in ceil(200 / ${ISSUE_BATCH}) GraphQL requests, each node whole`, async () => {
		const numbers = Array.from({length: 200}, (_, index) => index + 1);
		const issues = Object.fromEntries(
			numbers.map((n) => [n, {parent: 500, blockedBy: [n + 1], comments: ["a", "b"]}]),
		);
		const {github, nodes} = against(issues);

		const read = await nodes(numbers);

		expect(github.count(GRAPHQL)).toBe(Math.ceil(200 / ISSUE_BATCH));
		expect(github.log.every((line) => GRAPHQL.test(line))).toBe(true);
		expect(read.size).toBe(200);
		expect(read.get(7)).toEqual(
			present({
				number: 7,
				open: true,
				parent: 500,
				subIssues: [],
				blockedBy: [8],
				blocking: [],
				comments: 2,
			}),
		);
	});

	it("reads a pull request number and a number with no issue as Absent", async () => {
		const {nodes} = against({1: {}, 2: {pr: true}});

		const read = await nodes([1, 2, 3]);

		expect(read.get(1)?._tag).toBe("Present");
		expect(read.get(2)).toEqual({_tag: "Absent"});
		expect(read.get(3)).toEqual({_tag: "Absent"});
	});

	it("marks an issue whose connection runs past one page Unproven, never a short list", async () => {
		const many = Array.from({length: 150}, (_, index) => 1000 + index);
		const {nodes} = against({1: {subIssues: many}, 2: {}});

		const read = await nodes([1, 2]);

		expect(read.get(1)).toEqual({
			_tag: "Unproven",
			reason: "#1 was not read whole: received 100 of 150 sub-issues",
		});
		expect(read.get(2)?._tag).toBe("Present");
	});

	it("marks an issue whose node alone errored Unproven", async () => {
		const {nodes} = against({1: {nodeError: "Resource not accessible"}, 2: {}});

		const read = await nodes([1, 2]);

		expect(read.get(1)).toEqual({
			_tag: "Unproven",
			reason: "#1 carried an error: Resource not accessible",
		});
		expect(read.get(2)?._tag).toBe("Present");
	});

	it("reads every issue of a request that failed as a whole Unknown", async () => {
		const {nodes} = against({1: {}, 2: {}}, {graphqlStatus: 502});

		const read = await nodes([1, 2]);

		expect(read.get(1)?._tag).toBe("Unknown");
		expect(read.get(2)?._tag).toBe("Unknown");
	});
});

describe("readCommentCounts", () => {
	it("reads only the declared counts, in batches", async () => {
		const numbers = Array.from({length: 120}, (_, index) => index + 1);
		const {github, counts} = against(
			Object.fromEntries(numbers.map((n) => [n, {comments: ["x"]}])),
		);

		const read = await counts(numbers);

		expect(github.log).toHaveLength(Math.ceil(120 / ISSUE_BATCH));
		expect(github.log.every((line) => line.startsWith("graphql counts "))).toBe(true);
		expect(read.get(60)).toEqual(present(1));
	});
});

describe("reconcileComments", () => {
	const comment = (id: number): CommentRecord => ({
		id,
		author: "someone",
		createdAt: "",
		updatedAt: "",
		body: `comment ${id}`,
	});

	beforeEach(() => {
		process.env.FABRIKA_COMMENT_SCAN_DELAY_MS = "0";
	});
	afterEach(() => {
		delete process.env.FABRIKA_COMMENT_SCAN_DELAY_MS;
		delete process.env.FABRIKA_COMMENT_SCAN_ATTEMPTS;
	});

	/** Lists that serve `served[issue][k]` comments on read `k`, counts off `declared`. */
	const scripted = (
		served: Readonly<Record<number, ReadonlyArray<number>>>,
		declared: Readonly<Record<number, number>>,
	) => {
		const order: string[] = [];
		const reads = new Map<number, number>();
		const waves: CommentWaveReads<never> = {
			lists: (issues) =>
				Effect.sync(() =>
					issues.map((issue) => {
						const k = reads.get(issue) ?? 0;
						reads.set(issue, k + 1);
						order.push(`list #${issue}`);
						const steps = served[issue] ?? [0];
						const length = steps[Math.min(k, steps.length - 1)] ?? 0;
						return [issue, ok(Array.from({length}, (_, index) => comment(index)))] as const;
					}),
				),
			counts: (issues) =>
				Effect.sync(() => {
					order.push(`count ${issues.map((issue) => `#${issue}`).join(",")}`);
					return new Map(issues.map((issue) => [issue, present(declared[issue] ?? 0)]));
				}),
		};
		return {order, waves};
	};

	it("reads every count after the lists, in one batched read", async () => {
		const {order, waves} = scripted({1: [2], 2: [0], 3: [5]}, {1: 2, 2: 0, 3: 5});

		const scans = await Effect.runPromise(reconcileComments(REPO, [1, 2, 3], waves));

		expect(order).toEqual(["list #1", "list #2", "list #3", "count #1,#2,#3"]);
		expect(scans.get(3)).toEqual(
			ok({comments: Array.from({length: 5}, (_, index) => comment(index)), declared: 5, reads: 1}),
		);
	});

	it("re-reads a short list with its count and keeps the ones that settled", async () => {
		const {order, waves} = scripted({1: [1, 2], 2: [3]}, {1: 2, 2: 3});

		const scans = await Effect.runPromise(reconcileComments(REPO, [1, 2], waves));

		expect(order).toEqual(["list #1", "list #2", "count #1,#2", "list #1", "count #1"]);
		expect(scans.get(1)?._tag === "Ok" && scans.get(1)).toMatchObject({value: {reads: 2}});
		expect(scans.get(2)?._tag).toBe("Ok");
	});

	it("fails a list still shorter than its count after the bounded retries", async () => {
		process.env.FABRIKA_COMMENT_SCAN_ATTEMPTS = "3";
		const {order, waves} = scripted({1: [1]}, {1: 4});

		const scans = await Effect.runPromise(reconcileComments(REPO, [1], waves));

		expect(order.filter((line) => line === "list #1")).toHaveLength(3);
		expect(scans.get(1)).toEqual({
			_tag: "Failure",
			reason:
				"received 1 of 4 declared comment(s) after 3 read(s) — the comment list could not be made consistent with the count #1 declares for itself",
		});
	});
});
