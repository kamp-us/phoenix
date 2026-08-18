/**
 * The cleared repair rounds recorded on a PR — the read `build verdicts` folds and `build clear`
 * re-reads before granting another.
 *
 * A `cap-cleared` marker is bytes, and bytes are not authority. A row is **honoured** only when all
 * three clauses hold, the same conjunctive shape `grill rule` records a ruling under (#4938):
 *
 *   1. the marker parses, and names a round at or past the declared cap;
 *   2. its author is in the repo's `.fabrika.jsonc` grant-author set, read at the PR's **base** ref
 *      so a PR cannot widen the set that clears its own cap (#981);
 *   3. a dated authorization comment sits immediately before it, from that same author.
 *
 * Every miss is a row carrying its reason rather than a dropped marker: an operator who posted a
 * void grant must be able to see it was void, and a silently dropped one reads as a PR nobody ever
 * cleared.
 *
 * A read that could not complete — the config, a team's membership — is `Unknown`, never an empty
 * set. Resolving an unreadable ACL to "nobody granted" would be safe for the budget and wrong for
 * the answer, and resolving it the other way would hand out authority nobody proved.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {CommentRecord} from "../io/issues.ts";
import {CONFIG_PATH, type GrantAuthor, readCapClearAuthors} from "../repo-config.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {listTeamMembers, readFileAtRef} from "../ship/github.ts";
import {read as readClearance} from "../wire/cap-clearance.ts";

/** Any ISO-8601 date in the quoted authorization — the same dating rule `grill rule` enforces. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

export interface ClearanceRow {
	readonly round: number;
	readonly at: string;
	readonly by: string;
	readonly commentId: number;
	/** The dated authorization comment this grant rests on, or `null` when none was found. */
	readonly authorization: number | null;
	/** Whether all three clauses hold. Only an honoured row is budget. */
	readonly honoured: boolean;
	/** Why the row is not honoured. Absent on an honoured row. */
	readonly reason?: string;
}

export type ClearancesRead =
	| {readonly _tag: "Rows"; readonly rows: ReadonlyArray<ClearanceRow>}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** The rounds an honoured row grants — what `../cap-clearance.ts`'s derivations take. */
export const grantedFrom = (rows: ReadonlyArray<ClearanceRow>): ReadonlyArray<number> =>
	rows.filter((row) => row.honoured).map((row) => row.round);

export type Membership =
	| {readonly _tag: "Set"; readonly holds: (login: string) => boolean}
	| {readonly _tag: "Unusable"; readonly reason: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * The grant-author set as a predicate, with every team expanded once.
 *
 * Teams are resolved eagerly rather than per marker so a PR carrying several markers costs one
 * membership read per team; a **404 team** is proven to hold nobody, while a failed read is
 * `Unknown` — the split the whole group rests on.
 */
export const membershipAt = (
	repo: string,
	baseRef: string,
): Effect.Effect<Membership, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const file = yield* readFileAtRef(repo, CONFIG_PATH, baseRef);
		if (file._tag === "Unknown") {
			return {_tag: "Unknown" as const, reason: `${CONFIG_PATH} at ${baseRef}: ${file.reason}`};
		}
		if (file._tag === "Absent") {
			return {
				_tag: "Unusable" as const,
				reason: `${repo} carries no ${CONFIG_PATH} at ${baseRef} — nobody is configured to clear a round`,
			};
		}
		const declared = readCapClearAuthors(file.value);
		if (declared._tag === "Unusable") return {_tag: "Unusable" as const, reason: declared.reason};

		const logins = new Set<string>();
		for (const author of declared.authors as ReadonlyArray<GrantAuthor>) {
			if (author._tag === "User") {
				logins.add(author.login.toLowerCase());
				continue;
			}
			const members = yield* listTeamMembers(author.org, author.team);
			if (members._tag === "Unknown") {
				return {
					_tag: "Unknown" as const,
					reason: `@${author.org}/${author.team}'s membership: ${members.reason}`,
				};
			}
			if (members._tag === "Absent") continue;
			for (const member of members.value) logins.add(member.toLowerCase());
		}
		return {
			_tag: "Set" as const,
			holds: (login: string) => logins.has(login.trim().toLowerCase()),
		};
	});

/** Why this marker is not budget, or `null` when all three clauses hold. */
const refusalFor = (
	membership: Exclude<Membership, {readonly _tag: "Unknown"}>,
	baseRef: string,
	author: string,
	round: number,
	authorization: number | null,
): string | null => {
	if (membership._tag === "Unusable") return membership.reason;
	if (!membership.holds(author)) {
		return `${author} is not in ${CONFIG_PATH}'s grant-author set at ${baseRef}`;
	}
	if (round < CAP_ROUND) {
		return `round ${round} is below the declared cap of ${CAP_ROUND} — there was no round to clear`;
	}
	return authorization === null
		? "no dated authorization comment precedes the marker — a bare stamp is void (#4938)"
		: null;
};

/**
 * Every cap-clearance recorded on the PR, judged.
 *
 * The comments are handed in rather than re-listed: `build verdicts` already holds the full paged
 * set, and a second read could see a different one — two answers about one PR is exactly the drift
 * the one-door property exists to remove.
 */
export const clearancesOn = (
	repo: string,
	baseRef: string,
	comments: ReadonlyArray<CommentRecord>,
): Effect.Effect<ClearancesRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const marked = comments.flatMap((comment) => {
			const parsed = readClearance(comment.body);
			return parsed._tag === "Absent" ? [] : [{comment, parsed}];
		});
		if (marked.length === 0) return {_tag: "Rows" as const, rows: []};

		const membership = yield* membershipAt(repo, baseRef);
		if (membership._tag === "Unknown") {
			return {_tag: "Unknown" as const, reason: membership.reason};
		}

		const rows: ClearanceRow[] = [];
		for (const {comment, parsed} of marked) {
			const base = {by: comment.author, commentId: comment.id};
			if (parsed._tag === "Malformed") {
				rows.push({
					...base,
					round: 0,
					at: comment.createdAt,
					authorization: null,
					honoured: false,
					reason: `the marker is malformed: ${parsed.reason}`,
				});
				continue;
			}
			const {round, at} = parsed.value;
			const priorByAuthor = comments
				.filter((other) => other.id < comment.id && other.author === comment.author)
				.at(-1);
			const authorization =
				priorByAuthor !== undefined && ISO_DATE.test(priorByAuthor.body) ? priorByAuthor.id : null;
			const reason = refusalFor(membership, baseRef, comment.author, round, authorization);
			rows.push({
				...base,
				round,
				at,
				authorization,
				honoured: reason === null,
				...(reason === null ? {} : {reason}),
			});
		}
		return {_tag: "Rows" as const, rows};
	});
