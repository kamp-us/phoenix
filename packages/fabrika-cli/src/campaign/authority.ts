/**
 * Who may write the `## Campaigns` table — **two conjunctive clauses, neither substituting for the
 * other** (ADR 0294).
 *
 * 1. The configured set: the cited comment's author is in `.fabrika.jsonc`'s `campaignAuthors`,
 *    case-insensitively for a `@user` entry and by REST membership for a `@org/team` one.
 * 2. The live ACL: that same login's repository permission, read at the moment of the act, is one of
 *    `admin` / `maintain` / `write`.
 *
 * **Clause 2 is load-bearing here specifically.** These verbs run against a working tree before any
 * pull request exists, so there is no base ref to resolve `campaignAuthors` at and the file is the
 * one the same actor is editing — the "a checked-in identity list is instructions, not enforcement"
 * hole ADR 0055 supersedes 0051 to close. A login appended to the key on a branch, by somebody with
 * no collaboration on the repo, must not satisfy the check.
 */

import {Effect} from "effect";
import {clearsWriteFloor} from "../build/clearances.ts";
import type {GrantAuthor} from "../config/keys/cap-clear-authors.ts";
import type {Shell} from "../io/git.ts";
import {permissionFor} from "../io/pulls.ts";
import {teamHolds} from "./github.ts";

/** A read failed, so authority is UNKNOWN and nothing is written — the caller's `13`. */
export interface AuthorityUnknown {
	readonly _tag: "Unknown";
	readonly reason: string;
}

export type Declared = {readonly _tag: "Yes"} | {readonly _tag: "No"} | AuthorityUnknown;

export type Acl =
	/** Clause 2 holds. `level` is what the ACL answered, for the notice line. */
	| {readonly _tag: "Cleared"; readonly level: string}
	/**
	 * Below the floor — the caller's `21`. `level` is `null` for `permissionFor`'s **proven** 404,
	 * which is a different true thing from a level below the floor and prints as `no collaboration`.
	 */
	| {readonly _tag: "BelowFloor"; readonly level: string | null}
	| AuthorityUnknown;

/**
 * Clause 1, with every team resolved through one membership read each.
 *
 * Exported apart from {@link aclOf} because the two do not run back to back: the contract's
 * most-informative-first precedence puts a named-set miss (`16`) above a malformed marker (`15`) and
 * the ACL refusal (`21`) below both, so the marker checks sit between them.
 */
export const declaredBy = (authors: ReadonlyArray<GrantAuthor>, login: string): Shell<Declared> =>
	Effect.gen(function* () {
		const teams: Array<{readonly org: string; readonly team: string}> = [];
		for (const author of authors) {
			if (author._tag === "User") {
				if (author.login.toLowerCase() === login.toLowerCase()) return {_tag: "Yes" as const};
				continue;
			}
			teams.push({org: author.org, team: author.team});
		}
		for (const {org, team} of teams) {
			const read = yield* teamHolds(org, team, login);
			if (read._tag === "Unknown") {
				return {
					_tag: "Unknown" as const,
					reason: `cannot resolve membership of ${login} in @${org}/${team}: ${read.reason}`,
				};
			}
			if (read._tag === "NoTeam") {
				return {
					_tag: "Unknown" as const,
					reason: `campaignAuthors names @${org}/${team}, which ${org} does not have — fix the key`,
				};
			}
			if (read._tag === "Member") return {_tag: "Yes" as const};
		}
		return {_tag: "No" as const};
	});

/** Clause 2 — the live read, at the moment of the act. */
export const aclOf = (repo: string, login: string): Shell<Acl> =>
	Effect.gen(function* () {
		const permission = yield* permissionFor(repo, login);
		if (permission._tag === "Unknown") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot resolve @${login}'s permission on ${repo}: ${permission.reason}`,
			};
		}
		if (permission._tag === "Absent") return {_tag: "BelowFloor" as const, level: null};
		return clearsWriteFloor(permission.value)
			? {_tag: "Cleared" as const, level: permission.value}
			: {_tag: "BelowFloor" as const, level: permission.value};
	});
