/**
 * The pure "is this claim mine?" decision — the issue-scoped resolver verb's core,
 * IO-free and total. It answers the one question `write-code`'s Step-3.5 guard and
 * the orchestrator's pre-spawn check each hand-rolled inline: given an issue's claim
 * comments, the write+ authorized-author set, and our own session id, is the earliest
 * authorized claim *ours*?
 *
 * It **reuses** epic-lock's `resolveClaim` (the earliest-authorized-claim resolution,
 * ADR 0115 §2 / gh-issue-intake-formats.md §7) rather than shipping a second copy —
 * the AC of #3687 — and adds one projection on top: **default-deny**. Only a `won`
 * outcome is ours; every un-resolvable outcome (`no-session`, `no-winner`, `lost`)
 * answers **not-mine**, so a caller that cannot prove ownership backs off toward the
 * expensive-but-correct path rather than mutating on an unproven claim (the #3250
 * fail-safe license). This makes the mis-attribution guard fail-closed by
 * construction, not by a caller remembering to check.
 */
import {
	type ClaimResolutionInput,
	type ClaimWinner,
	resolveClaim,
} from "../epic-lock/claim-resolution.ts";

/** Why the decision resolved the way it did — the `resolveClaim` outcome tag, surfaced for observability. */
export type ClaimReason = "won" | "lost" | "no-winner" | "no-session";

/** The issue-scoped resolver verdict: is the claim ours, and (for a report) the resolved earliest owner. */
export interface ClaimVerdict {
	/** Ours iff the earliest authorized claim's session is ours — false on every un-resolvable outcome (default-deny). */
	readonly mine: boolean;
	/** The `resolveClaim` outcome that decided it — the audit trail for a caller's log/back-off message. */
	readonly reason: ClaimReason;
	/** The resolved earliest authorized claim, when one exists (`won`/`lost`); `null` when none resolved. */
	readonly winner: ClaimWinner | null;
}

/**
 * Resolve whether the earliest authorized claim on an issue is ours, **default-deny**.
 * Delegates the resolution to the shared `resolveClaim` core and collapses its
 * four-way outcome to a mine/not-mine answer: `won` ⇒ mine; `lost`, `no-winner`, and
 * `no-session` all ⇒ not-mine. The un-resolvable outcomes are the fail-safe path —
 * an absent claim, a foreign owner, or a missing session id can never read as ours.
 */
export const claimIsMine = (input: ClaimResolutionInput): ClaimVerdict => {
	const outcome = resolveClaim(input);
	switch (outcome._tag) {
		case "won":
			return {mine: true, reason: "won", winner: outcome.winner};
		case "lost":
			return {mine: false, reason: "lost", winner: outcome.winner};
		case "no-winner":
			return {mine: false, reason: "no-winner", winner: null};
		case "no-session":
			return {mine: false, reason: "no-session", winner: null};
	}
};
