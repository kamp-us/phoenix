/**
 * Whether a lane on disk is one somebody is actually driving — the board read the concurrency cap
 * counts seats by (ADR 0365's 2026-09-08 amendment).
 *
 * A reader a caller passes rather than a seam [`concurrency.ts`](concurrency.ts) reaches through on
 * its own, which is what keeps the counting testable with no board at all — the shape `lane open`'s
 * [`expectation.ts`](expectation.ts) reader established.
 *
 * `Unknown` is why this is a sum and not a boolean: an unreadable comment thread or ACL leaves the
 * question unanswered, and reading that as "unclaimed" would free a seat on a failed read, which is
 * the permissive arm the cap exists to refuse.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readClaimants} from "../build/claim.ts";
import {resolveRepo} from "../io/issues.ts";
import {claimTarget, LANE_CLAIM} from "./claim.ts";

export type ClaimHold =
	| {readonly _tag: "Claimed"; readonly token: string}
	| {readonly _tag: "Unclaimed"}
	| {readonly _tag: "Unknown"; readonly reason: string};

export type ClaimHoldReader<R> = (lane: string) => Effect.Effect<ClaimHold, never, R>;

/**
 * The live reader: the earliest authorized `lane-claim:` marker on the lane's own issue, or none.
 *
 * A lane key naming no board number — a chore name, a directory a sweep renamed — is `Unclaimed`
 * rather than `Unknown`: there is nowhere for a marker to live, so no driver can be holding it. The
 * repo resolves once and is memoized across the whole count.
 */
export const claimHoldReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ClaimHoldReader<ChildProcessSpawner.ChildProcessSpawner> => {
	let resolved: string | null = null;
	return (lane) =>
		Effect.gen(function* () {
			const target = claimTarget({_tag: "Issue", lane});
			if (target._tag === "Inert") return {_tag: "Unclaimed" as const};
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown" as const,
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					};
				}
				resolved = attempt.value;
			}
			const read = yield* readClaimants(resolved, target.number, LANE_CLAIM);
			if (read._tag === "Unknown") return {_tag: "Unknown" as const, reason: read.reason};
			return read.holder === null
				? {_tag: "Unclaimed" as const}
				: {_tag: "Claimed" as const, token: read.holder.token};
		});
};
