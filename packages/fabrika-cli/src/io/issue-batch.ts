/**
 * Many issues read in one GraphQL request: aliased `repository{iN: issue(number: N){…}}` nodes, at
 * most {@link ISSUE_BATCH} to a request. A whole-table reader asks for a wave of issues at once
 * here rather than spending four REST calls on each one.
 *
 * Every answer is per issue, and it is one of four things. `Present` carries a node whose every
 * connection was proven whole — its `totalCount` equals the nodes received — so a short edge list
 * is not a state this module can hand on. `Absent` is GitHub's own `NOT_FOUND` on that alias,
 * which is what a pull request number or a number with no issue answers. `Unproven` is an issue
 * this request could not prove whole — a connection past one page, or an error on that node alone —
 * and it is the caller's to re-read singly. `Unknown` is a request that failed as a whole, so no
 * issue in it was read.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10097
 */

import {Effect} from "effect";
import {type Api, authed, graphqlRead, type Rest, refusalText} from "./gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {
	absent,
	type CommentRecord,
	type CommentScan,
	commentScanBounds,
	type Existence,
	present,
	unknown,
} from "./issues.ts";
import {isRecord} from "./json.ts";

/** How many issues one GraphQL request asks for. */
export const ISSUE_BATCH = 50;

/** How many edges of one kind a request reads per issue; an issue with more is `Unproven`. */
const EDGE_PAGE = 100;

/** One issue as a batched read proves it: its state, parent, native edges and comment count. */
export interface IssueNode {
	readonly number: number;
	readonly open: boolean;
	readonly parent: number | null;
	readonly subIssues: ReadonlyArray<number>;
	readonly blockedBy: ReadonlyArray<number>;
	readonly blocking: ReadonlyArray<number>;
	/** The platform's own count of the issue's comments. */
	readonly comments: number;
}

/** One issue's answer from a batched read; `Unproven` is re-read singly by the caller. */
export type Batched<A> = Existence<A> | {readonly _tag: "Unproven"; readonly reason: string};

export const unproven = <A>(reason: string): Batched<A> => ({_tag: "Unproven", reason});

const edges = (name: string): string => `${name}(first:${EDGE_PAGE}){totalCount nodes{number}}`;

const NODE_FIELDS = `number state parent{number} ${edges("subIssues")} ${edges("blockedBy")} ${edges("blocking")} comments{totalCount}`;

const COUNT_FIELDS = "number comments{totalCount}";

const alias = (issue: number): string => `i${issue}`;

const queryFor = (fields: string, issues: ReadonlyArray<number>): string =>
	`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${issues
		.map((issue) => `${alias(issue)}:issue(number:${issue}){${fields}}`)
		.join(" ")}}}`;

/** A connection's node numbers, only when the nodes received are all the connection declares. */
const wholeList = (value: unknown, what: string): Attempt<ReadonlyArray<number>> => {
	if (!isRecord(value) || typeof value.totalCount !== "number" || !Array.isArray(value.nodes)) {
		return fail(`its ${what} did not read as a connection`);
	}
	const numbers: number[] = [];
	for (const node of value.nodes) {
		if (!isRecord(node) || typeof node.number !== "number") {
			return fail(`one of its ${what} carries no issue number`);
		}
		numbers.push(node.number);
	}
	return numbers.length === value.totalCount
		? ok(numbers)
		: fail(`received ${numbers.length} of ${value.totalCount} ${what}`);
};

const commentCount = (node: Record<string, unknown>): Attempt<number> =>
	isRecord(node.comments) && typeof node.comments.totalCount === "number"
		? ok(node.comments.totalCount)
		: fail("it carries no comment count");

const toNode = (node: Record<string, unknown>): Attempt<IssueNode> => {
	const {number, state, parent} = node;
	if (typeof number !== "number" || (state !== "OPEN" && state !== "CLOSED")) {
		return fail("it did not read as an issue");
	}
	const up =
		parent === null
			? null
			: isRecord(parent) && typeof parent.number === "number"
				? parent.number
				: undefined;
	if (up === undefined) return fail("its parent carries no issue number");
	const children = wholeList(node.subIssues, "sub-issues");
	if (children._tag === "Failure") return children;
	const blockers = wholeList(node.blockedBy, "blocked-by edges");
	if (blockers._tag === "Failure") return blockers;
	const blocked = wholeList(node.blocking, "blocking edges");
	if (blocked._tag === "Failure") return blocked;
	const comments = commentCount(node);
	if (comments._tag === "Failure") return comments;
	return ok({
		number,
		open: state === "OPEN",
		parent: up,
		subIssues: children.value,
		blockedBy: blockers.value,
		blocking: blocked.value,
		comments: comments.value,
	});
};

/** The GraphQL errors of one response, keyed by the alias they name; `null` for a pathless one. */
const errorsByAlias = (
	errors: ReadonlyArray<unknown>,
): ReadonlyMap<string, {readonly type: string; readonly message: string}> | null => {
	const out = new Map<string, {readonly type: string; readonly message: string}>();
	for (const error of errors) {
		if (!isRecord(error) || !Array.isArray(error.path)) return null;
		const [root, key] = error.path;
		if (root !== "repository" || typeof key !== "string") return null;
		out.set(key, {
			type: typeof error.type === "string" ? error.type : "",
			message: typeof error.message === "string" ? error.message : "an error",
		});
	}
	return out;
};

/** One request's answer, per issue; a response that fails as a whole is a `Failure`. */
const readBatch = <A>(
	token: string,
	owner: string,
	name: string,
	issues: ReadonlyArray<number>,
	fields: string,
	parse: (node: Record<string, unknown>) => Attempt<A>,
): Api<Attempt<ReadonlyMap<number, Batched<A>>>> =>
	Effect.map(
		graphqlRead(token, queryFor(fields, issues), {owner, name}),
		(outcome: Rest): Attempt<ReadonlyMap<number, Batched<A>>> => {
			if (outcome._tag === "Unreachable") return fail(outcome.reason);
			if (outcome.status < 200 || outcome.status >= 300) return fail(refusalText(outcome));
			const body = outcome.body;
			const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
			const named = errorsByAlias(errors);
			if (named === null) {
				return fail("GitHub answered 200 and the GraphQL query carried an error on no one issue");
			}
			const data = isRecord(body) && isRecord(body.data) ? body.data : null;
			const repository = data !== null && isRecord(data.repository) ? data.repository : null;
			if (repository === null)
				return fail("GitHub answered 200 but its output names no repository");
			const out = new Map<number, Batched<A>>();
			for (const issue of issues) {
				const error = named.get(alias(issue));
				const node = repository[alias(issue)];
				if (error !== undefined) {
					out.set(
						issue,
						error.type === "NOT_FOUND" && node === null
							? absent<A>()
							: unproven<A>(`#${issue} carried an error: ${error.message}`),
					);
					continue;
				}
				if (!isRecord(node) || node.number !== issue) {
					out.set(issue, unproven<A>(`#${issue} did not read as an issue`));
					continue;
				}
				const parsed = parse(node);
				out.set(
					issue,
					parsed._tag === "Ok"
						? present(parsed.value)
						: unproven<A>(`#${issue} was not read whole: ${parsed.reason}`),
				);
			}
			return ok(out);
		},
	);

/** Every issue's answer, {@link ISSUE_BATCH} to a request, the requests made one after another. */
const readBatched = <A>(
	repo: string,
	issues: ReadonlyArray<number>,
	fields: string,
	parse: (node: Record<string, unknown>) => Attempt<A>,
): Shell<ReadonlyMap<number, Batched<A>>> =>
	Effect.gen(function* () {
		const out = new Map<number, Batched<A>>();
		const wanted = [...new Set(issues)];
		const [owner, name] = repo.split("/");
		if (owner === undefined || name === undefined) {
			for (const issue of wanted) out.set(issue, unknown<A>(`\`${repo}\` is not owner/name`));
			return out;
		}
		for (let start = 0; start < wanted.length; start += ISSUE_BATCH) {
			const batch = wanted.slice(start, start + ISSUE_BATCH);
			const read = yield* authed((token) => readBatch(token, owner, name, batch, fields, parse));
			for (const issue of batch) {
				out.set(
					issue,
					read._tag === "Ok"
						? (read.value.get(issue) ?? unknown<A>("unread"))
						: unknown<A>(read.reason),
				);
			}
		}
		return out;
	});

/** State, parent, sub-issues, blocked-by, blocking and comment count for every issue named. */
export const readIssueNodes = (
	repo: string,
	issues: ReadonlyArray<number>,
): Shell<ReadonlyMap<number, Batched<IssueNode>>> => readBatched(repo, issues, NODE_FIELDS, toNode);

/** Only the comment count of every issue named — the denominator a comment list is proven against. */
export const readCommentCounts = (
	repo: string,
	issues: ReadonlyArray<number>,
): Shell<ReadonlyMap<number, Batched<number>>> =>
	readBatched(repo, issues, COUNT_FIELDS, commentCount);

/** The reads one wave of comment reconciliation is made of, passed in so the order is provable. */
export interface CommentWaveReads<R> {
	/** Each named issue's comment list. */
	readonly lists: (
		issues: ReadonlyArray<number>,
	) => Effect.Effect<
		ReadonlyArray<readonly [number, Attempt<ReadonlyArray<CommentRecord>>]>,
		never,
		R
	>;
	/** The count each named issue declares, read only after that issue's list. */
	readonly counts: (
		issues: ReadonlyArray<number>,
	) => Effect.Effect<ReadonlyMap<number, Existence<number>>, never, R>;
}

/**
 * `listCommentsReconciled` over a wave of issues: every list first, then every count in one
 * batched read, so each count is still the later fact and a list shorter than it is still a read
 * that provably missed something. A short list is re-read with its count on the same linear
 * backoff and bounds, and a shortfall that survives every attempt is that issue's `Failure`.
 */
export const reconcileComments = <R>(
	repo: string,
	issues: ReadonlyArray<number>,
	reads: CommentWaveReads<R>,
): Effect.Effect<ReadonlyMap<number, Attempt<CommentScan>>, never, R> =>
	Effect.gen(function* () {
		const {attempts, delayMs} = commentScanBounds();
		const out = new Map<number, Attempt<CommentScan>>();
		const short = new Map<number, string>();
		let pending = [...new Set(issues)];
		for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt++) {
			if (attempt > 1) yield* Effect.sleep(delayMs * (attempt - 1));
			const listed = new Map<number, ReadonlyArray<CommentRecord>>();
			for (const [issue, list] of yield* reads.lists(pending)) {
				if (list._tag === "Failure") out.set(issue, list);
				else listed.set(issue, list.value);
			}
			const counts: ReadonlyMap<number, Existence<number>> = listed.size === 0
				? new Map()
				: yield* reads.counts([...listed.keys()]);
			const again: number[] = [];
			for (const [issue, comments] of listed) {
				const count = counts.get(issue) ?? unknown<number>(`#${issue}'s count was not read`);
				if (count._tag === "Absent") out.set(issue, fail(`#${issue} is not in ${repo}`));
				else if (count._tag === "Unknown") out.set(issue, fail(count.reason));
				else if (comments.length >= count.value) {
					out.set(issue, ok({comments, declared: count.value, reads: attempt}));
				} else {
					short.set(issue, `received ${comments.length} of ${count.value} declared comment(s)`);
					again.push(issue);
				}
			}
			pending = again;
		}
		for (const issue of pending) {
			out.set(
				issue,
				fail(
					`${short.get(issue)} after ${attempts} read(s) — the comment list could not be made consistent with the count #${issue} declares for itself`,
				),
			);
		}
		return out;
	});
