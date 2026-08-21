/**
 * The claim marker this group writes, and the pack marker it re-exports.
 *
 * The pack's marker is a **registered wire format**, so its grammar lives in
 * `../wire/handoff-pack.ts` and is only re-exported here. The claim is internal to this group —
 * nothing outside it reads one — and a format nobody meets through is not a wire format.
 *
 * <!-- anchor: CLAIM-KEY-IS-THE-RUN-NONCE --> The claim key is the caller's run nonce, never a
 * session id and never a pid: the session id is pane-constant rather than per-run (#5028)
 * and sibling subagents of one parent share it (#4516), so two successors booted from one parent
 * would key onto one namespace and each would classify the other's claim as its own. Nothing here
 * reads the environment — the nonce arrives as an argument.
 *
 * **These are the group's own grammar, not `../build/claim.ts`'s.** That module's `composeMarker`
 * hardcodes the `build-claim:` prefix, its `MARKER_RE` matches only that, and its `resolveOwnership`
 * compares a **session** token, so `markersIn` would find zero markers on a pack and every claim
 * would read as unclaimed.
 */

import {type Instant, instant, type PackNonce, packNonce} from "../wire/handoff-pack.ts";

export {
	composeMarker as composePackMarker,
	type Instant,
	instant,
	type PackNonce,
	packNonce,
	reaches as reachesForPackMarker,
	read as readPack,
} from "../wire/handoff-pack.ts";

/** A claim on one sealed pack, keyed on the claiming run's nonce. */
export interface ClaimMarker {
	readonly nonce: PackNonce;
	/** The comment id of the pack being claimed. The bare key `pack` is never an id in this group. */
	readonly packComment: number;
	readonly claimedAt: Instant;
}

const CLAIM_REACH = /^<!--\s*fabrika:handoff\s+claim\b/;
const CLAIM =
	/^<!--\s*fabrika:handoff\s+claim\s+nonce=(\S+)\s+packComment=(\d+)\s+claimedAt=(\S+)\s*-->$/;

const firstNonBlankLine = (body: string): string =>
	(body.split("\n").find((line) => line.trim() !== "") ?? "").trim();

export const composeClaimMarker = (marker: ClaimMarker): string =>
	`<!-- fabrika:handoff claim nonce=${marker.nonce} packComment=${marker.packComment} claimedAt=${marker.claimedAt} -->`;

/** Whether the bytes reach for a claim at all — a near-miss is not tolerated, but it is visible. */
export const reachesForClaim = (body: string): boolean => CLAIM_REACH.test(firstNonBlankLine(body));

/** The claim on a comment's first non-blank line, or `null` when it does not conform. */
export const readClaimMarker = (body: string): ClaimMarker | null => {
	const matched = CLAIM.exec(firstNonBlankLine(body));
	if (matched === null) return null;
	const nonce = packNonce(matched[1] ?? "");
	const claimedAt = instant(matched[3] ?? "");
	if (nonce === null || claimedAt === null) return null;
	return {nonce, packComment: Number.parseInt(matched[2] ?? "0", 10), claimedAt};
};

/** The wall clock as this group stamps it: ISO-8601 UTC, seconds, trailing `Z`. */
export const stampOf = (now: Date): Instant => {
	const stamp = instant(now.toISOString().replace(/\.\d{3}Z$/, "Z"));
	if (stamp === null) {
		// Unreachable: `Date.prototype.toISOString` is specified to emit exactly this grammar.
		throw new Error(`"${now.toISOString()}" is not an ISO-8601 UTC instant`);
	}
	return stamp;
};
