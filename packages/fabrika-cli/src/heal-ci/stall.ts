/**
 * The stall classification: an **ordered, total** predicate chain over facts already read.
 *
 * First match wins, and the order is the contract — two implementers walking it in a different order
 * produce different answers on the same PR, which is exactly the drift a prose taxonomy invites. It
 * is pure so the whole taxonomy is testable without a repository.
 *
 * The chain has two phases, and the split is what makes totality provable. Arms 1-6 are
 * attention-independent: they name states that block the PR no matter who is watching. Arms 7-10 are
 * the attendance phase, reached only once the PR is otherwise able to proceed, so the only remaining
 * question is whether anybody is moving it.
 */

export const STALL_TOKENS = [
	"attended",
	"ungated",
	"gated-unshipped",
	"claim-stale",
	"red",
	"check-surface",
	"linkage-refused",
	"blocked-human",
	"wedged",
	"not-open",
] as const;

export type StallToken = (typeof STALL_TOKENS)[number];

export type CiToken = "green" | "red" | "pending" | "wedged" | "no-runs" | "none";

export interface StallFacts {
	readonly open: boolean;
	readonly wedged: boolean;
	/** `null` when the protection surface is unprobeable — arm 3 is then skipped, never passed. */
	readonly surfaceGap: boolean | null;
	readonly ci: CiToken;
	readonly linkageRefused: boolean;
	readonly humanBlocked: boolean;
	/** Any owner signal at all: an assignee, however stale. */
	readonly hasOwner: boolean;
	/** Minutes since the owner's last activity, or `null` when it could not be read. */
	readonly ownerIdleMinutes: number | null;
	readonly behindBase: number;
	readonly queued: boolean;
	readonly mergeIntentArmed: boolean;
	/** Every required namespace holds an in-force pass at this head. Vacuously true when none is. */
	readonly gatesSatisfied: boolean;
	readonly dwellMinutes: number;
	readonly driftCommits: number;
}

export type StaleReason = "inactivity" | "ground-drift" | "unreadable-activity";

export interface StallVerdict {
	readonly token: StallToken;
	/** Why arm 8 fired, for the stderr notice — `null` on every other arm. */
	readonly staleReason: StaleReason | null;
}

/**
 * Arm 7's whole test: **any positive signal of motion**.
 *
 * CI running at this head *is* the PR moving, which is why `pending` belongs here and not below —
 * ranking a strand class above `attended` would report a PR whose author pushed two minutes ago as
 * abandoned.
 */
const attended = (facts: StallFacts): boolean =>
	facts.queued ||
	facts.mergeIntentArmed ||
	facts.ci === "pending" ||
	(facts.ownerIdleMinutes !== null && facts.ownerIdleMinutes <= facts.dwellMinutes);

/**
 * Which of arm 8's three signals proved the claim stale.
 *
 * An unreadable activity stamp is neither provably live nor provably old, and reading unknown as
 * stale is the fail-safe direction: a false strand costs one look, a false `attended` is the
 * incident.
 */
const staleReasonOf = (facts: StallFacts): StaleReason =>
	facts.ownerIdleMinutes === null
		? "unreadable-activity"
		: facts.behindBase > facts.driftCommits
			? "ground-drift"
			: "inactivity";

export const classifyStall = (facts: StallFacts): StallVerdict => {
	const plain = (token: StallToken): StallVerdict => ({token, staleReason: null});

	if (!facts.open) return plain("not-open");
	if (facts.wedged) return plain("wedged");
	if (facts.surfaceGap === true) return plain("check-surface");
	if (facts.ci === "red") return plain("red");
	if (facts.linkageRefused) return plain("linkage-refused");
	if (facts.humanBlocked) return plain("blocked-human");
	if (attended(facts)) return plain("attended");
	// Arm 8 is the whole owner-exists complement of arm 7, not a subset of it: an owner whose activity
	// stamp is unreadable is neither provably live nor provably old and must still land somewhere.
	if (facts.hasOwner) return {token: "claim-stale", staleReason: staleReasonOf(facts)};
	return plain(facts.gatesSatisfied ? "gated-unshipped" : "ungated");
};

/**
 * The strand age in minutes: from the later of the head push and the PR's last activity, to now.
 *
 * Derived here once because the sweep orders on it, and two derivations would order two boards
 * differently. Floored at `0` — a clock skew that puts the last activity in the future is not a
 * negative age.
 */
export const strandAgeMinutes = (
	pushedAt: string | null,
	lastActivityAt: string | null,
	now: number,
): number => {
	const stamps = [pushedAt, lastActivityAt]
		.map((at) => (at === null ? Number.NaN : Date.parse(at)))
		.filter((at) => Number.isFinite(at));
	const latest = stamps.length === 0 ? now : Math.max(...stamps);
	return Math.max(0, Math.floor((now - latest) / 60_000));
};
