/**
 * `merge-intent` pure core — the decision behind ship-it's no-parked-merge-intent invariant
 * (ADR 0198, issue #3723).
 *
 * ship-it enqueues with `gh pr merge --auto`. When that request does not take effect at the
 * head it was made against, GitHub keeps it **armed**, and it fires the moment the missing
 * requirement lands — on a §CP PR, the instant a fresh control-plane approval arrives. That is
 * an enqueue with **no ship-it run in between**, so the assertions ship-it makes *at* enqueue
 * time (current-head verdicts, the run-evidence bundle, the leak scan, unresolved threads) are
 * skipped at the decisive instant (observed on PR #3700, where `added_to_merge_queue` fired one
 * second after the approving review).
 *
 * The fix is a lifecycle rule, not a new enqueue primitive: an armed merge intent is a
 * transient artifact of a completed gate pass, never a durable state. This core answers the one
 * question each lifecycle site asks — *may an armed intent survive here?* — as a pure function
 * of the PR's live merge state, so the answer cannot drift across shippers (the `cp-cardinality`
 * / `merge-queue-classify` split: the `gh` IO in the service, the branch in a tested core).
 */

/**
 * Where in ship-it's lifecycle the question is asked. The site matters because only one of
 * them — `post-enqueue` — can legitimately observe an armed request that is the *sanctioned*
 * mechanism rather than a parked one.
 */
export type IntentSite = "preflight" | "refuse" | "post-enqueue" | "ejected";

/** The live merge state the decision reads; resolved over `gh` REST by the service. */
export interface MergeIntentState {
	/**
	 * Does the PR carry an armed auto-merge request (`auto_merge != null`)? `"unknown"` when the
	 * read failed — treated as armed, because clearing an intent that was never there costs a
	 * no-op while leaving one parked costs an ungated enqueue.
	 */
	readonly armed: boolean | "unknown";
	/** The merge already landed — there is nothing left to park. */
	readonly merged: boolean;
	/** Currently in the merge queue (the last merge-queue timeline event is `added_to_merge_queue`). */
	readonly queued: boolean;
	/** The merge queue has governed this PR at least once (any `added_to_merge_queue` event). */
	readonly everQueued: boolean;
}

export type IntentAction = "disarm" | "keep";

export interface IntentDecision {
	readonly action: IntentAction;
	/** Human-readable justification naming the deciding signal — printed by the bin. */
	readonly reason: string;
}

const at = (action: IntentAction, reason: string): IntentDecision => ({action, reason});

const DISARM_REASON: Record<IntentSite, string> = {
	preflight:
		"an intent armed BEFORE this run's guards ran is backed by no gate pass at this head — clear it so only a completed Step-4 enqueue can arm one",
	refuse:
		"this run refused to enqueue — an intent left armed would enqueue on the next bare approval, with no ship-it run asserting the machine gates in between",
	"post-enqueue":
		"the merge queue governs this PR but it is not queued — the enqueue did not take effect at this head, so what remains is a parked intent, not a queue entry",
	ejected:
		"the queue dropped the PR — it must re-enter through a fresh ship-it gate pass, never by a surviving intent firing on the re-approval",
};

/**
 * Decide whether an armed merge intent may survive at this lifecycle site (ADR 0198).
 *
 * Precedence:
 *   1. `merged` — the merge landed; nothing to park.
 *   2. `queued` — a live queue entry is a gated in-flight merge that a completed gate pass
 *      authorized. ship-it never dequeues it: fighting the queue is a different decision, and
 *      the async merge is the queue's to finish (ADR 0132).
 *   3. `armed === false` — nothing armed, so nothing to clear.
 *   4. `post-enqueue` on a PR the queue has NEVER governed — the pre-queue auto-merge regime
 *      (ADR 0132 transition safety, and any foreign repo with no queue), where the armed
 *      request *is* the sanctioned enqueue mechanism. Only this site gets the exemption:
 *      at `preflight` the same arm is stale by construction, whatever the regime.
 *   5. Otherwise — disarm.
 *
 * Fail-closed by construction: an unreadable `armed` (`"unknown"`) falls through to disarm. The
 * asymmetry is deliberate — a needless disarm costs one idempotent re-ship, a surviving parked
 * intent costs an ungated enqueue.
 */
export const decideMergeIntent = (site: IntentSite, state: MergeIntentState): IntentDecision => {
	if (state.merged) {
		return at("keep", "the merge already landed — there is no intent left to park");
	}
	if (state.queued) {
		return at(
			"keep",
			"a live merge-queue entry is a gated in-flight merge, not a parked intent — ship-it never dequeues what a completed gate pass enqueued (ADR 0132)",
		);
	}
	if (state.armed === false) {
		return at("keep", "no armed auto-merge request on the PR — nothing is parked");
	}
	if (site === "post-enqueue" && !state.everQueued) {
		return at(
			"keep",
			"no merge-queue event has ever governed this PR ⇒ the pre-queue auto-merge regime, where the armed request IS the sanctioned enqueue mechanism (ADR 0132 transition safety)",
		);
	}
	const unknown = state.armed === "unknown" ? " (arm state unreadable — treated as armed)" : "";
	return at("disarm", `${DISARM_REASON[site]}${unknown}`);
};
