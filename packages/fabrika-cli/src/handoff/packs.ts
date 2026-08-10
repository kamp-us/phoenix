/**
 * How an issue's comments resolve to **the latest sealed pack**, and to whoever holds its claim.
 *
 * One reader, shared by `handoff read` and `handoff claim`, because the two must not disagree: were
 * only `read` to apply the ACL, an unauthorized newest pack would have `read` honour one comment and
 * `claim` target another — in the very sequence the skill mandates.
 *
 * <!-- anchor: A-MALFORMED-LATEST-PACK-REFUSES --> **A malformed pack is a refusal and never
 * `none`, and never a `disregarded` row.** Reporting `none` over a pack that exists tells a
 * successor nobody handed off, and it starts the work over. The scope is the **latest**
 * marker-bearing pack specifically — falling back to an older one would hand a successor a stale
 * pack believing it current.
 *
 * <!-- anchor: THE-DIGEST-IS-RECHECKED-ON-READ --> The packed digest is **recomputed** from the
 * nineteen fields parsed out of the proven half and compared against both printed copies, the
 * marker's and the JSON's. Without it the digest is decorative on the read path: a pack comment is
 * editable by its author and by anyone with write access, so two copies of a number nobody
 * recomputes can drift with nothing marking it.
 *
 * <!-- anchor: THE-AUTHOR-IS-RESOLVED-NOT-TRUSTED --> A pack's author is resolved against repository
 * permissions before the pack is honoured (ADR 0055). A comment carrying a well-formed marker is
 * still a comment anyone with a GitHub account can post, and its `## Next act` is a sentence a
 * successor reads and then acts on. A permission read that **fails** is UNKNOWN for the whole call,
 * never a grant.
 *
 * **Zero packs is a fact; a comment read that could not complete is not.** Most issues carry no
 * pack, and that is the ordinary state — but a page that could not be fetched leaves the answer
 * UNKNOWN, never `none` (ADR 0092).
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {permissionFor} from "../io/pulls.ts";
import type {HandoffPack} from "../wire/handoff-pack.ts";
import {digestOf, type GroundState, parseGround} from "./ground.ts";
import {
	type ClaimMarker,
	reachesForClaim,
	reachesForPackMarker,
	readClaimMarker,
	readPack,
} from "./markers.ts";

/** The permissions that let an account's pack or claim count. Anything else is recorded and ignored. */
export const AUTHORIZED: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/** Why an artifact was not honoured. A closed set, so a consumer can branch on it. */
export type DisregardedReason = "unauthorized" | "superseded";

export interface DisregardedRow {
	/** `pack` or `claim`, so the id beside it is never ambiguous. */
	readonly kind: "pack" | "claim";
	readonly comment: number;
	readonly reason: DisregardedReason;
	readonly detail: string;
}

export interface SealedPack {
	readonly comment: number;
	readonly author: string;
	readonly pack: HandoffPack;
	readonly ground: GroundState;
}

export interface HeldBy {
	readonly claimNonce: string;
	readonly claimedAt: string;
	readonly claimComment: number;
	readonly by: string;
}

export type PackResolution =
	| {
			readonly _tag: "None";
			readonly disregarded: ReadonlyArray<DisregardedRow>;
			readonly comments: number;
	  }
	| {
			readonly _tag: "Sealed";
			readonly sealed: SealedPack;
			readonly heldBy: HeldBy | null;
			readonly disregarded: ReadonlyArray<DisregardedRow>;
			readonly comments: number;
	  }
	/** The latest pack exists and does not parse, or its digest disagrees with what it labels. */
	| {readonly _tag: "Malformed"; readonly comment: number; readonly reason: string}
	/** A comment page or a permission read did not complete. The answer is UNKNOWN, never `none`. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/** One `permissionFor` per distinct login, or the proof that the lookup did not complete. */
const authorizer = (repo: string) => {
	const cache = new Map<string, string | null>();
	return (
		login: string,
	): Effect.Effect<
		| {readonly _tag: "Resolved"; readonly permission: string | null}
		| {
				readonly _tag: "Unknown";
				readonly reason: string;
		  },
		never,
		ChildProcessSpawner.ChildProcessSpawner
	> =>
		Effect.gen(function* () {
			const seen = cache.get(login);
			if (seen !== undefined) return {_tag: "Resolved" as const, permission: seen};
			const resolved = yield* permissionFor(repo, login);
			if (resolved._tag === "Unknown") {
				return {
					_tag: "Unknown" as const,
					reason: `cannot resolve ${login}'s permission: ${resolved.reason}`,
				};
			}
			const permission = resolved._tag === "Present" ? resolved.value : null;
			cache.set(login, permission);
			return {_tag: "Resolved" as const, permission};
		});
};

/** The parsed pack, or why these bytes carrying a pack marker are not one. */
const readSealed = (
	comment: CommentRecord,
):
	| {readonly _tag: "Sealed"; readonly pack: HandoffPack; readonly ground: GroundState}
	| {
			readonly _tag: "No";
			readonly reason: string;
	  } => {
	const read = readPack(comment.body);
	if (read._tag === "Absent") return {_tag: "No", reason: read.reason};
	if (read._tag === "Malformed") return {_tag: "No", reason: read.reason};
	const ground = parseGround(read.value.groundJson);
	if (ground._tag === "Unusable") return {_tag: "No", reason: ground.reason};
	const recomputed = digestOf(ground.value);
	if (recomputed !== read.value.groundDigest || recomputed !== ground.value.groundDigest) {
		return {
			_tag: "No",
			reason: `its groundDigest does not match the proven half it labels (marker ${read.value.groundDigest}, body ${ground.value.groundDigest}, recomputed ${recomputed})`,
		};
	}
	return {_tag: "Sealed", pack: read.value, ground: ground.value};
};

/**
 * Resolve the latest sealed pack on `issue`, its claim, and everything inspected on the way.
 *
 * `disregarded` is **bounded by the walk**: packs newer than the one honoured, and any claim naming
 * a superseded pack — never an unbounded history of every pack an issue has ever carried.
 */
export const resolvePack = (
	repo: string,
	issue: number,
): Effect.Effect<PackResolution, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const listed = yield* listComments(repo, issue);
		if (listed._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot page #${issue}'s comments: ${listed.reason}`,
			};
		}
		const comments = listed.value;
		const permissionOf = authorizer(repo);
		const disregarded: DisregardedRow[] = [];

		const packComments = comments.filter((comment) => reachesForPackMarker(comment.body));
		let honoured: SealedPack | null = null;
		for (const comment of [...packComments].reverse()) {
			const sealed = readSealed(comment);
			if (sealed._tag === "No") {
				return {_tag: "Malformed" as const, comment: comment.id, reason: sealed.reason};
			}
			const authority = yield* permissionOf(comment.author);
			if (authority._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: authority.reason};
			}
			if (authority.permission === null || !AUTHORIZED.has(authority.permission)) {
				disregarded.push({
					kind: "pack",
					comment: comment.id,
					reason: "unauthorized",
					detail: `${comment.author} resolves to ${authority.permission ?? "no collaboration"} on ${repo}, below write`,
				});
				continue;
			}
			honoured = {
				comment: comment.id,
				author: comment.author,
				pack: sealed.pack,
				ground: sealed.ground,
			};
			break;
		}

		if (honoured === null) {
			return {_tag: "None" as const, disregarded, comments: comments.length};
		}

		let heldBy: HeldBy | null = null;
		for (const comment of comments) {
			if (!reachesForClaim(comment.body)) continue;
			const claim: ClaimMarker | null = readClaimMarker(comment.body);
			// A comment whose first line does not match is not a claim — not a near-miss to be tolerated,
			// and not a pack whose absence would be reported.
			if (claim === null) continue;
			const authority = yield* permissionOf(comment.author);
			if (authority._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: authority.reason};
			}
			if (authority.permission === null || !AUTHORIZED.has(authority.permission)) {
				disregarded.push({
					kind: "claim",
					comment: comment.id,
					reason: "unauthorized",
					detail: `${comment.author} resolves to ${authority.permission ?? "no collaboration"} on ${repo}, below write`,
				});
				continue;
			}
			if (claim.packComment !== honoured.comment) {
				// A later `take` supersedes an earlier pack by ordering, which leaves that pack's claim
				// behind. Surfacing it is what keeps a successor from inferring an empty field where
				// somebody was in fact working the previous pack.
				disregarded.push({
					kind: "claim",
					comment: comment.id,
					reason: "superseded",
					detail: `it claims pack #${claim.packComment}, which #${honoured.comment} superseded`,
				});
				continue;
			}
			if (heldBy === null) {
				heldBy = {
					claimNonce: claim.nonce,
					claimedAt: claim.claimedAt,
					claimComment: comment.id,
					by: comment.author,
				};
			}
		}

		return {
			_tag: "Sealed" as const,
			sealed: honoured,
			heldBy,
			disregarded,
			comments: comments.length,
		};
	});
