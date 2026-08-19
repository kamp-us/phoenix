/**
 * The cleared repair rounds recorded on a PR — the read `build verdicts` folds and `build clear`
 * re-reads before granting another.
 *
 * A `cap-cleared` marker is bytes, and bytes are not authority. A row is **honoured** only when all
 * four clauses hold, the same conjunctive shape `grill rule` records a ruling under (#4938):
 *
 *   1. the marker parses, and names a round at or past the declared cap;
 *   2. its author is in the repo's `.fabrika.jsonc` grant-author set, read at the PR's **base** ref
 *      so a PR cannot widen the set that clears its own cap (#981);
 *   3. that same author holds `write+` on the repo, read live from GitHub's ACL;
 *   4. a dated authorization comment sits immediately before it, from that same author, and is not
 *      itself a `cap-cleared` marker.
 *
 * Clause 3 is ADR 0055 applied: the committed file says whom the repo *nominates*, and the ACL says
 * who may actually act, so the two are intersected and a login with no collaboration clears nothing.
 * A committed list alone has no author gate, which is the thing 0055 supersedes 0051 to forbid; ADR
 * 0294 records why the file is nevertheless the place the nomination is written down.
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
import {permissionFor} from "../io/pulls.ts";
import {CONFIG_PATH, type GrantAuthor, readCapClearAuthors} from "../repo-config.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {listTeamMembers, readFileAtRef} from "../ship/github.ts";
import {read as readClearance} from "../wire/cap-clearance.ts";

/** Any ISO-8601 date in the quoted authorization — the same dating rule `grill rule` enforces. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** The repository permissions that count as `write+`, the floor every fabrika ACL read stands on. */
const WRITE_FLOOR: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/** Whether a resolved permission level clears the write floor. `null` is no collaboration at all. */
export const clearsWriteFloor = (level: string | null): boolean =>
	level !== null && WRITE_FLOOR.has(level);

export interface ClearanceRow {
	readonly round: number;
	readonly at: string;
	readonly by: string;
	readonly commentId: number;
	/** The dated authorization comment this grant rests on, or `null` when none was found. */
	readonly authorization: number | null;
	/** Whether all four clauses hold. Only an honoured row is budget. */
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

export type Permissions =
	| {readonly _tag: "Levels"; readonly levelOf: (login: string) => string | null}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * Each login's live repository permission, read once per distinct login.
 *
 * A 404 collaborator is proven to hold nothing and resolves to `null`; a read that failed is
 * `Unknown`, because "GitHub did not answer" and "this account may not write" are different facts
 * and only one of them is a refusal.
 */
export const permissionsFor = (
	repo: string,
	logins: ReadonlyArray<string>,
): Effect.Effect<Permissions, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const levels = new Map<string, string | null>();
		for (const login of new Set(logins.map((raw) => raw.trim()))) {
			const read = yield* permissionFor(repo, login);
			if (read._tag === "Unknown") {
				return {
					_tag: "Unknown" as const,
					reason: `${login}'s repository permission on ${repo}: ${read.reason}`,
				};
			}
			levels.set(login, read._tag === "Present" ? read.value : null);
		}
		return {_tag: "Levels" as const, levelOf: (login: string) => levels.get(login.trim()) ?? null};
	});

/**
 * Clause 4: the comment immediately before the marker, from its author, dated, and not itself a
 * `cap-cleared` marker — `grill rule`'s `adjacentAuthorization` (`../grill/read-verb.ts`), same shape.
 *
 * The adjacency and the marker exclusion are one clause and neither is optional. Taking the last
 * prior comment by that author instead lets a bare second marker rest on the FIRST grant's own
 * marker — the marker body carries an ISO-8601 date, so it passes the dating test — and every grant
 * after the first would need no authorization at all, which is the bare stamp #4938 ruled void.
 */
const adjacentAuthorization = (
	comments: ReadonlyArray<CommentRecord>,
	index: number,
	author: string,
): number | null => {
	const previous = comments[index - 1];
	if (previous === undefined || previous.author !== author) return null;
	if (readClearance(previous.body)._tag !== "Absent") return null;
	return ISO_DATE.test(previous.body) ? previous.id : null;
};

/** Why this marker is not budget, or `null` when all four clauses hold. */
const refusalFor = (
	membership: Exclude<Membership, {readonly _tag: "Unknown"}>,
	permissions: Extract<Permissions, {readonly _tag: "Levels"}>,
	repo: string,
	baseRef: string,
	author: string,
	round: number,
	authorization: number | null,
): string | null => {
	if (membership._tag === "Unusable") return membership.reason;
	if (!membership.holds(author)) {
		return `${author} is not in ${CONFIG_PATH}'s grant-author set at ${baseRef}`;
	}
	const level = permissions.levelOf(author);
	if (!clearsWriteFloor(level)) {
		return `${author} resolves to ${level ?? "no collaboration"} on ${repo}, below write — authority is the ACL's, never ${CONFIG_PATH}'s alone (ADR 0055)`;
	}
	if (round < CAP_ROUND) {
		return `round ${round} is below the declared cap of ${CAP_ROUND} — there was no round to clear`;
	}
	return authorization === null
		? "no dated authorization comment from that author sits immediately before the marker — a bare stamp is void (#4938)"
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
		const marked = comments.flatMap((comment, index) => {
			const parsed = readClearance(comment.body);
			return parsed._tag === "Absent" ? [] : [{comment, index, parsed}];
		});
		if (marked.length === 0) return {_tag: "Rows" as const, rows: []};

		const membership = yield* membershipAt(repo, baseRef);
		if (membership._tag === "Unknown") {
			return {_tag: "Unknown" as const, reason: membership.reason};
		}
		// Only the authors the config already names are worth an ACL read: one the file does not name
		// is refused on that clause alone, and reading it would let a hiccup on an irrelevant login
		// turn a plainly-void marker into an UNKNOWN fold.
		const permissions = yield* permissionsFor(
			repo,
			membership._tag === "Set"
				? marked.flatMap(({comment}) => (membership.holds(comment.author) ? [comment.author] : []))
				: [],
		);
		if (permissions._tag === "Unknown") {
			return {_tag: "Unknown" as const, reason: permissions.reason};
		}

		const rows: ClearanceRow[] = [];
		for (const {comment, index, parsed} of marked) {
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
			const authorization = adjacentAuthorization(comments, index, comment.author);
			const reason = refusalFor(
				membership,
				permissions,
				repo,
				baseRef,
				comment.author,
				round,
				authorization,
			);
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
