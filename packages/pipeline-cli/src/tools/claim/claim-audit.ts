/**
 * The pure legacy-claim audit — which open lanes are held by a claim marker written before
 * presence stamping existed, and which of those may be retired. IO-free and total.
 *
 * ADR 0191 supersession only ever drops a claim its presence stamp proves dead, so a marker
 * written before every writer stamped (#3987, PR #4015) is permanently indeterminate: it wins
 * the earliest-authorized-claim tiebreak forever, and no later claim — however live, however
 * legitimate — can displace it. The lane is silently unrepairable until a dispatch hits the
 * mis-attribution guard and (correctly) refuses (#4031).
 *
 * The fix is a bounded cleanup, **not** a change to how claims resolve. Nothing here is read by
 * `resolveWinner`, `claimIsMine`, or `claimStatus`; the resolution rule and its fail-closed
 * direction are untouched, and a **stamped** claim is never a candidate whatever its age. What
 * this adds is a way to name the pre-stamping population and hand each member to the one
 * retraction mechanism that already exists (`claim release`, #3780) instead of growing a second.
 *
 * Retirement needs three facts, not one, because "unstamped" alone does not mean "legacy": a
 * post-cutoff writer still emits an unstamped marker when it cannot read the process table or
 * this machine's identity (`presence-io.ts`), and such a marker may belong to a running agent.
 * So a candidate must (1) predate the stamping cutoff, (2) be older than a safety margin that
 * no single run outlives, and (3) be the only shape its session left on the lane. Every doubt
 * holds the claim — the same direction the resolver takes.
 */
import {parseClaimPresence} from "../epic-lock/claim-presence.ts";
import {
	authorizedClaims,
	type ClaimComment,
	type ClaimLiveness,
	type ClaimWinner,
	parseClaimSession,
	resolveWinner,
} from "../epic-lock/claim-resolution.ts";

/**
 * The instant after which every claim writer stamps presence: the merge of PR #4015 (#3987),
 * which routed the last hand-rolled writer through the one presence-stamping producer. A marker
 * created before this could not have been stamped by any writer; one created after it was
 * written by a stamping writer that degraded, which is a different case and out of scope here.
 * Overridable (`--cutoff`) so a foreign install can name its own stamping era (ADR 0062).
 */
export const STAMPING_CUTOFF = "2026-07-25T20:52:36Z";

/**
 * How old a pre-cutoff marker must be before retirement will touch it. The cutoff bounds the
 * population but says nothing about liveness — a run that claimed minutes before it may still be
 * working — so age is the only evidence left once a marker carries no stamp to probe.
 *
 * Two days, not the one a coder run would justify: claims are also written by long-lived
 * orchestrator sessions, which routinely outlive a single build. No margin is *proof* a claimant is
 * gone, which is why retirement is an operator act on a report that names each session, and why
 * `--min-age-hours` exists — lower it deliberately for a claimant you have confirmed is gone,
 * never to make a bulk sweep reach further.
 */
export const DEFAULT_MIN_AGE_HOURS = 48;

/** Why a locked lane's owning marker is or is not retirable — the audit's whole verdict. */
export type LaneReason =
	/** Unstamped, pre-cutoff, aged past the margin: the bounded legacy population. */
	| "pre-stamping"
	/** Unstamped but written after the cutoff — a degraded stamping writer, not a legacy marker. */
	| "post-cutoff"
	/** Pre-cutoff but younger than the safety margin: its session could still be running. */
	| "within-safety-margin"
	/** The same session also left a stamped marker here, which a token-scoped release would take. */
	| "session-restamped"
	/** A timestamp that would not parse — nothing to compare, so the claim stands. */
	| "indeterminate-age";

/** One open lane held by an unstamped claim: the blast-radius row, and its disposition. */
export interface LockedLane {
	readonly issue: number;
	/** The unstamped marker holding the lane (the earliest live-or-indeterminate authorized claim). */
	readonly owner: ClaimWinner;
	/** The later authorized claims it outranks — the legitimate claimants it is shadowing. */
	readonly shadowed: ReadonlyArray<ClaimWinner>;
	readonly disposition: "retire" | "hold";
	readonly reason: LaneReason;
}

/** The bounds retirement is decided against; all three are inputs so the decision stays testable. */
export interface AuditPolicy {
	/** ISO-8601 UTC; markers created at or after it are not pre-stamping. */
	readonly cutoff: string;
	readonly minAgeMs: number;
	/** ISO-8601 UTC "now" — the clock the age is measured against. */
	readonly now: string;
}

/** One lane's canonical claim state, as the IO shell reads it off the issue. */
export interface LaneInput {
	readonly issue: number;
	readonly comments: ReadonlyArray<ClaimComment>;
	readonly authorizedAuthors: ReadonlyArray<string>;
	readonly liveness?: ReadonlyMap<number, ClaimLiveness> | undefined;
}

export interface AuditReport {
	/** How many lanes were examined — a zero scan is a broken read, not a clean result (ADR 0092). */
	readonly scanned: number;
	/** Every examined lane whose owning marker carries no presence stamp (the blast radius). */
	readonly locked: ReadonlyArray<LockedLane>;
	/** The subset retirement may act on — `locked` filtered to `disposition: "retire"`. */
	readonly retirable: ReadonlyArray<LockedLane>;
}

/** Milliseconds since `at`, or `null` when either instant will not parse. */
const ageMs = (at: string, now: string): number | null => {
	const then = Date.parse(at);
	const nowMs = Date.parse(now);
	return Number.isFinite(then) && Number.isFinite(nowMs) ? nowMs - then : null;
};

/** Does `at` fall strictly before `cutoff`? `null` when either instant will not parse. */
const isBefore = (at: string, cutoff: string): boolean | null => {
	const atMs = Date.parse(at);
	const cutoffMs = Date.parse(cutoff);
	return Number.isFinite(atMs) && Number.isFinite(cutoffMs) ? atMs < cutoffMs : null;
};

/**
 * Decide one owner marker's disposition. Ordered so the report names the *first* reason a lane
 * is held rather than an arbitrary one, and so `retire` is reachable only after every check.
 */
const disposition = (
	owner: ClaimWinner,
	comments: ReadonlyArray<ClaimComment>,
	policy: AuditPolicy,
): LaneReason => {
	const before = isBefore(owner.createdAt, policy.cutoff);
	const age = ageMs(owner.createdAt, policy.now);
	if (before === null || age === null) return "indeterminate-age";
	if (!before) return "post-cutoff";
	if (age < policy.minAgeMs) return "within-safety-margin";
	// Retirement runs through `claim release`, which retracts BY TOKEN — so a stamped marker from
	// the same session would go with it. Holding here is what keeps the one retraction mechanism
	// safe to reuse instead of forking a comment-id-scoped second one (#3780).
	const restamped = comments.some(
		(comment) =>
			parseClaimSession(comment.body) === owner.session &&
			parseClaimPresence(comment.body) !== null,
	);
	return restamped ? "session-restamped" : "pre-stamping";
};

/**
 * Audit one lane: `null` when nothing authorized holds it, or when the holder carries a presence
 * stamp — a stamped claim is resolved by ADR 0191 liveness and is none of this tool's business.
 */
export const auditLane = (input: LaneInput, policy: AuditPolicy): LockedLane | null => {
	const owner = resolveWinner(input.comments, input.authorizedAuthors, input.liveness);
	if (owner === null) return null;
	const ownerComment = input.comments.find((comment) => comment.id === owner.id);
	if (ownerComment === undefined || parseClaimPresence(ownerComment.body) !== null) return null;
	const claims = authorizedClaims(input.comments, input.authorizedAuthors);
	const shadowed = claims.filter(
		(claim) =>
			claim.createdAt > owner.createdAt ||
			(claim.createdAt === owner.createdAt && claim.id > owner.id),
	);
	const reason = disposition(owner, input.comments, policy);
	return {
		issue: input.issue,
		owner,
		shadowed,
		disposition: reason === "pre-stamping" ? "retire" : "hold",
		reason,
	};
};

export const auditReport = (inputs: ReadonlyArray<LaneInput>, policy: AuditPolicy): AuditReport => {
	const locked: LockedLane[] = [];
	for (const input of inputs) {
		const lane = auditLane(input, policy);
		if (lane !== null) locked.push(lane);
	}
	return {
		scanned: inputs.length,
		locked,
		retirable: locked.filter((lane) => lane.disposition === "retire"),
	};
};
