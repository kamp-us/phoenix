/**
 * The GitHub surface this group needs that no shipped module already makes.
 *
 * Two of these are genuinely new to fabrika, and they are the reason this file exists: **nothing
 * shipped writes a sub-issue link.** `plan/github.ts`'s `listSubIssues` is the read half — imported
 * and used as-is where numbers are enough — and the write half (`POST .../sub_issues`,
 * `DELETE .../sub_issue`) is derived here. Both take the child's **database `id`, not its number**,
 * which is the one shape v1 got right and is worth not rediscovering.
 *
 * The two readers below carry fields the shipped readers drop, which is the same justification
 * `plan/github.ts` gives for `getChild` over `getIssue`: {@link listSubIssueEntries} carries the `id`
 * the link and unlink take, and {@link readChildBack} carries labels, assignees **and** milestone
 * together, which no shipped shape does — and a read-back that cannot see all three cannot prove the
 * one create call landed every birth attribute.
 *
 * The package's two standing disciplines hold throughout, unchanged by the move off `gh` (ADR 0315):
 * every list read pages in full and hands back the proof it did, and a shape that is not what was
 * asked for is a failure, never an empty result. Every write here still proves itself by a read-back
 * or by the caller's own re-read — a write's own response echo is not evidence anywhere it was not
 * evidence before.
 */

import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	attemptOf,
	existenceOf,
	pagedWithLinkProof,
	resolveToken,
	restRead,
	restWrite,
} from "../io/gh-api.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {type Existence, type IssueRow, unknown} from "../io/issues.ts";
import {isRecord} from "../io/json.ts";

/**
 * What these functions need: the HTTP client they call over, and the spawner `resolveToken` may
 * reach for when neither env var names a credential.
 */
type Called<A> = Effect.Effect<
	A,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

const truncated = (what: string): string =>
	`the ${what} read stopped at the page cap with another page outstanding`;

/** One existing child, with the id the sub-issue relation is keyed on. */
export interface SubIssueEntry {
	readonly number: number;
	readonly id: number;
	readonly title: string;
	readonly labels: ReadonlyArray<string>;
}

const toSubIssueEntry = (value: unknown): SubIssueEntry | null => {
	if (!isRecord(value) || typeof value.number !== "number" || typeof value.id !== "number") {
		return null;
	}
	const names = Array.isArray(value.labels)
		? value.labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: [];
	if (names.includes(null)) return null;
	return {
		number: value.number,
		id: value.id,
		title: typeof value.title === "string" ? value.title : "",
		labels: names as ReadonlyArray<string>,
	};
};

/** The epic's children from the native sub-issue list, paginated in full, with their ids. */
export const listSubIssueEntries = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	epic: number,
): Called<Attempt<ReadonlyArray<SubIssueEntry>>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const read = yield* pagedWithLinkProof(token.value, `repos/${repo}/issues/${epic}/sub_issues`);
		if (read._tag === "Failure") return read;
		if (!read.value.exhausted) return fail(truncated("sub-issue"));
		const entries: SubIssueEntry[] = [];
		for (const value of read.value.entries) {
			const entry = toSubIssueEntry(value);
			if (entry === null) return fail("GitHub answered 200 but one entry is not a sub-issue");
			entries.push(entry);
		}
		return ok(entries);
	});

/**
 * Every open issue in the repository, paged, pull requests filtered out — the dedup ranker's queue
 * half.
 *
 * Unlike `openIssuesWithLabel` this one is deliberately **unscoped by label**: the question a planner
 * asks is "does this work already exist anywhere in the open backlog", and a label-scoped read would
 * answer a narrower one while looking like an answer to the wider.
 */
export const openBacklog = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
): Called<Attempt<ReadonlyArray<IssueRow>>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const read = yield* pagedWithLinkProof(token.value, `repos/${repo}/issues?state=open`);
		if (read._tag === "Failure") return read;
		if (!read.value.exhausted) return fail(truncated("open backlog"));
		const rows: IssueRow[] = [];
		for (const value of read.value.entries) {
			if (!isRecord(value) || typeof value.number !== "number" || typeof value.title !== "string") {
				return fail("GitHub answered 200 but one entry is not an issue row");
			}
			if (value.pull_request !== undefined && value.pull_request !== null) continue;
			rows.push({number: value.number, title: value.title});
		}
		return ok(rows);
	});

export interface ChildCreate {
	readonly title: string;
	readonly body: string;
	readonly labels: ReadonlyArray<string>;
	/** The milestone **number** resolved from its title, or `null` for an unhomed child. */
	readonly milestone: number | null;
	readonly assignees: ReadonlyArray<string>;
}

export interface CreatedChild {
	readonly number: number;
	/** The database id — what the sub-issue link and unlink take. */
	readonly id: number;
}

/**
 * Create the child with **every birth attribute in the one call**.
 *
 * v1's create hardcoded exactly three `labels[]` with no pass-through and set no milestone, so a
 * fourth required label could only be applied by a follow-up PATCH — and a follow-up PATCH opens a
 * window in which the child exists with **no** `ready-for:` value, which is the fail-open shape the
 * #4780 ruling forbids.
 */
export const createChildIssue = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	input: ChildCreate,
): Called<Attempt<CreatedChild>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restWrite(token.value, "POST", `repos/${repo}/issues`, {
			title: input.title,
			body: input.body,
			labels: input.labels,
			assignees: input.assignees,
			...(input.milestone === null ? {} : {milestone: input.milestone}),
		});
		return attemptOf(outcome, (payload) =>
			isRecord(payload) && typeof payload.number === "number" && typeof payload.id === "number"
				? ok({number: payload.number, id: payload.id})
				: fail("GitHub answered 2xx but its body is not a created issue"),
		);
	});

/** Link a child to its epic. The relation takes the child's `id`, never its number. */
export const linkSubIssue = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	epic: number,
	id: number,
): Called<Attempt<void>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restWrite(
			token.value,
			"POST",
			`repos/${repo}/issues/${epic}/sub_issues`,
			{
				sub_issue_id: id,
			},
		);
		return attemptOf(outcome, () => ok<void>(undefined));
	});

/** Unlink a child from its epic — the same `id`-not-number shape the link uses. */
export const unlinkSubIssue = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	epic: number,
	id: number,
): Called<Attempt<void>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restWrite(
			token.value,
			"DELETE",
			`repos/${repo}/issues/${epic}/sub_issue`,
			{sub_issue_id: id},
		);
		return attemptOf(outcome, () => ok<void>(undefined));
	});

/** Close a child as `not_planned` — the only close spelling a supersede may use. */
export const closeAsNotPlanned = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	child: number,
): Called<Attempt<void>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const outcome = yield* restWrite(token.value, "PATCH", `repos/${repo}/issues/${child}`, {
			state: "closed",
			state_reason: "not_planned",
		});
		return attemptOf(outcome, () => ok<void>(undefined));
	});

/** What a create's read-back has to be able to see, so every birth attribute is provable. */
export interface ChildReadback {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	readonly assignees: ReadonlyArray<string>;
	readonly milestone: string | null;
	readonly state: string;
	readonly stateReason: string | null;
	readonly body: string;
}

const toChildReadback = (value: unknown): ChildReadback | null => {
	if (!isRecord(value) || typeof value.number !== "number") return null;
	const names = Array.isArray(value.labels)
		? value.labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: [];
	if (names.includes(null)) return null;
	const logins = Array.isArray(value.assignees)
		? value.assignees.map((a) => (isRecord(a) && typeof a.login === "string" ? a.login : null))
		: [];
	if (logins.includes(null)) return null;
	const milestone = value.milestone;
	return {
		number: value.number,
		labels: (names as ReadonlyArray<string>).toSorted(),
		assignees: (logins as ReadonlyArray<string>).toSorted(),
		milestone: isRecord(milestone) && typeof milestone.title === "string" ? milestone.title : null,
		state: typeof value.state === "string" ? value.state : "",
		stateReason: typeof value.state_reason === "string" ? value.state_reason : null,
		body: typeof value.body === "string" ? value.body : "",
	};
};

/** One child re-read from the API. The create response's own echo is never evidence. */
export const readChildBack = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	child: number,
): Called<Existence<ChildReadback>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return unknown<ChildReadback>(token.reason);
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/issues/${child}`);
		return existenceOf(outcome, (body) => {
			const payload = toChildReadback(body);
			return payload === null
				? fail("GitHub answered 200 but its body is not an issue")
				: ok(payload);
		});
	});
