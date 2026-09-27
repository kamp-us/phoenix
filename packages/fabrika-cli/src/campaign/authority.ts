/**
 * Who may write the `## Campaigns` table — **two conjunctive clauses, neither substituting for the
 * other**: the control-plane set narrows the live ACL and never replaces it.
 *
 * 1. The control-plane set: the cited comment's author is one of the accounts `.github/CODEOWNERS`
 *    names on the default branch, teams expanded (`../ship/roster.ts`, read by `./guards.ts`).
 * 2. The live ACL: that same login's repository permission, read at the moment of the act, is one of
 *    `admin` / `maintain` / `write`.
 *
 * **Clause 2 is load-bearing here specifically.** Team membership is edited in org settings with no
 * pull request, so a roster alone is a list somebody can change outside review. The permission read
 * at the moment of the act is what an account actually holds.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9852
 */

import {Effect} from "effect";
import {clearsWriteFloor} from "../build/clearances.ts";
import type {Shell} from "../io/git.ts";
import {permissionFor} from "../io/pulls.ts";

/** A read failed, so authority is UNKNOWN and nothing is written — the caller's `13`. */
export interface AuthorityUnknown {
	readonly _tag: "Unknown";
	readonly reason: string;
}

export type Acl =
	/** Clause 2 holds. `level` is what the ACL answered, for the notice line. */
	| {readonly _tag: "Cleared"; readonly level: string}
	/**
	 * Below the floor — the caller's `21`. `level` is `null` for `permissionFor`'s **proven** 404,
	 * which is a different true thing from a level below the floor and prints as `no collaboration`.
	 */
	| {readonly _tag: "BelowFloor"; readonly level: string | null}
	| AuthorityUnknown;

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
