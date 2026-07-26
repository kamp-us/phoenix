/**
 * `merge-queue-classify` core — the pure, IO-free classifier for ship-it Step 5.5's
 * bounded post-enqueue reconcile (issue #1921).
 *
 * ship-it enqueues a PR to GitHub's merge queue and then watches a bounded batch window
 * to classify the terminal state (ADR
 * [0132](../../../../../.decisions/0132-merge-queue-for-base-freshness.md)): did the
 * queue land the batch (`merged`), is the PR still in the queue (`queued`), did the
 * queue drop it without merging (`ejected`), or is it still settling into the queue
 * (`pending`)? The old discriminator inferred `ejected` from a momentary
 * `mergeStateStatus != QUEUED` while OPEN — but a freshly-enqueued PR reads
 * `mergeStateStatus = CLEAN` for a few seconds *before* GitHub flips it CLEAN → QUEUED,
 * so a genuinely-queued PR was FALSE-classified `ejected` on the first poll (the #1906
 * live instance: an ejection comment posted on a healthy queued PR, then retracted by
 * hand).
 *
 * The fix keys the verdict off the **authoritative** merge-queue signal — the REST
 * issue-timeline events GitHub emits: `added_to_merge_queue` on enqueue and
 * `removed_from_merge_queue` on a genuine ejection (GitHub "Managing a merge queue";
 * verified live against these events on PR #1906). Classification is **last-merge-queue-
 * event-wins**, which also survives a re-enqueue (add → remove → add ⇒ still queued).
 * `mergeStateStatus` is retained only as a *positive* still-queued hint (`QUEUED`),
 * never as the ejection discriminator.
 *
 * Those two reads are authoritative but **not timely**: during the #4011 ship both lagged
 * the true merge state by ~30–60 minutes, so the classifier printed `queued` on 15 polls
 * after the PR had already merged. The base branch stayed current throughout, so a third
 * signal corroborates a non-merged read — `baseBranchSquash`, whether the base branch
 * already carries this PR's single-parent squash (#4057). It only ever promotes to
 * `merged`; absence carries no evidence, which keeps the classifier fail-closed away from
 * a false ship.
 *
 * The IO lives in `command.ts` (the thin bin, which reads the PR state + timeline via
 * `gh`); this file is the pure predicate over already-resolved ground-truth signals so
 * the classification contract is unit-testable without a live queue (ADR 0082; the
 * core-in-its-own-file idiom, #855).
 */

/** The last merge-queue timeline event observed for the PR, or `null` when none yet exists. */
export type LastMergeQueueEvent = "added_to_merge_queue" | "removed_from_merge_queue" | null;

/**
 * Whether the base branch already carries this PR's squash (the freshness cross-check above):
 *   - `landed`     — a single-parent base-branch commit carries this PR's squash subject.
 *   - `absent`     — the scanned window carries no such commit. NOT an ejection signal — a
 *                    healthy queued PR and an ejected one both read `absent`.
 *   - `unreadable` — the read faulted or was not made. No evidence at all.
 */
export type BaseBranchSquash = "landed" | "absent" | "unreadable";

/** The ground-truth signals the reconcile reads per poll — the classifier's whole input. */
export interface MergeQueueSignals {
	/** Did the queue land the merge? True on `merged==true` or PR `state==MERGED`. */
	readonly merged: boolean;
	/** The PR `state` from `gh pr view` — `OPEN` / `MERGED` / `CLOSED`. */
	readonly state: string;
	/**
	 * The **last** merge-queue timeline event (`added_to_merge_queue` /
	 * `removed_from_merge_queue`), or `null` when the queue has emitted none yet — the
	 * enqueue-settle window the old logic mis-read as an ejection.
	 */
	readonly lastMergeQueueEvent: LastMergeQueueEvent;
	/**
	 * Does the timeline carry a `merged` event? The queue emits `removed_from_merge_queue` as it
	 * CONSUMES the entry to land the batch, so on a successful merge that removal pairs with a
	 * `merged` event ≤1s away — #4143 both at 00:53:07Z, #4164 removal 01:38:30Z / merged
	 * 01:38:31Z, #4076 00:27:43Z / 00:27:44Z (#4155). Either order appears in the array, so
	 * ordering discriminates nothing; the presence of the `merged` event does. Optional: absent ⇒
	 * no such event was read ⇒ no evidence (#4155).
	 */
	readonly mergedTimelineEvent?: boolean | undefined;
	/**
	 * `mergeStateStatus` from `gh pr view` — used only as a *positive* still-queued hint
	 * (`QUEUED`), never to infer ejection. Optional: absent ⇒ treated as unknown.
	 */
	readonly mergeStateStatus?: string | undefined;
	/**
	 * Whether the base branch carries this PR's squash. Optional: absent ⇒ the read was not
	 * made ⇒ no evidence, exactly like `unreadable`.
	 */
	readonly baseBranchSquash?: BaseBranchSquash | undefined;
}

/**
 * The terminal reconcile outcome:
 *   - `merged`  — the queue landed the batch. Terminal success.
 *   - `ejected` — a genuine dequeue: NOT merged AND the last merge-queue event is
 *                 `removed_from_merge_queue` AND the timeline carries NO `merged` event.
 *                 Route back to repair/re-queue.
 *   - `queued`  — still in the queue: NOT merged AND (last event is
 *                 `added_to_merge_queue` OR `mergeStateStatus == QUEUED`). Keep polling.
 *                 It is not proof of health — an ejection that has not yet surfaced in the
 *                 timeline reads identically (the residual window ship-it Step 5.5 accepts
 *                 and bounds, #4057).
 *   - `pending` — the enqueue-settle window: NOT merged, OPEN, and NO merge-queue event
 *                 yet (incl. OPEN + CLEAN before the QUEUED flip). NEVER an ejection.
 */
export type MergeOutcome = "merged" | "ejected" | "queued" | "pending";

/** The classification: the outcome + a human-readable reason naming the deciding signal. */
export interface Classification {
	readonly outcome: MergeOutcome;
	readonly reason: string;
}

const at = (outcome: MergeOutcome, reason: string): Classification => ({outcome, reason});

/**
 * Classify one reconcile poll from the ground-truth signals — the pure fix for #1921.
 *
 * Precedence (authoritative-signal-first):
 *   1. `merged` — merged==true or state==MERGED ⇒ terminal success. Checked first: a
 *      landed merge outranks any stale queue event (the final `removed_from_merge_queue`
 *      the queue emits *as* it merges must not read as an ejection — #1906 carried both
 *      events, but it merged).
 *   1b. `merged` — the base branch already carries this PR's squash. Ranked with (1), above
 *      the ejection check, for the same reason (1) is first: a landed merge outranks both a
 *      stale not-merged read and the removal event the queue emits as it merges.
 *   2. `ejected` — NOT merged AND last merge-queue event is `removed_from_merge_queue` AND the
 *      timeline carries no `merged` event. This is the ONLY ejection signal: a genuine dequeue,
 *      not a momentary state read, and not the removal the queue emits as it lands the batch.
 *   2b. `queued` — the removal IS paired with a `merged` event: the queue consumed the entry to
 *      land it. Not an ejection, and not yet `merged` either — a `merged` timeline event alone is
 *      one signal, and merge evidence is `merged_at` non-null PLUS that event, so the reconcile
 *      keeps polling until the PR state (or the base-branch squash) confirms (#4155).
 *   3. `queued` — NOT merged AND (last event `added_to_merge_queue` OR
 *      mergeStateStatus==QUEUED). A well-formed pending in the queue; keep polling.
 *   4. `pending` — NOT merged AND no merge-queue event yet (the settle window, incl.
 *      OPEN + CLEAN before the QUEUED flip). The #1906 race. NEVER `ejected`.
 *
 * A momentary OPEN + non-QUEUED state with no `removed_from_merge_queue` event is never
 * an ejection — that is the whole defect this classifier removes.
 */
export const classify = (s: MergeQueueSignals): Classification => {
	if (s.merged || s.state === "MERGED") {
		return at(
			"merged",
			"merged==true or state==MERGED — the queue landed the batch (terminal success)",
		);
	}
	if (s.baseBranchSquash === "landed") {
		return at(
			"merged",
			"the base branch carries this PR's single-parent squash — the merge landed, whatever the lagging PR-state and timeline reads say",
		);
	}
	if (s.lastMergeQueueEvent === "removed_from_merge_queue") {
		if (s.mergedTimelineEvent === true) {
			return at(
				"queued",
				"removed_from_merge_queue paired with a merged timeline event — the queue consumed the entry to land the batch, not an ejection; holding for merged_at to confirm",
			);
		}
		return at(
			"ejected",
			"not merged and the last merge-queue event is removed_from_merge_queue — a genuine dequeue",
		);
	}
	if (s.lastMergeQueueEvent === "added_to_merge_queue") {
		return at(
			"queued",
			"last merge-queue event is added_to_merge_queue (no subsequent removal) — still queued",
		);
	}
	if (s.mergeStateStatus === "QUEUED") {
		return at("queued", "mergeStateStatus==QUEUED — still in the queue");
	}
	// No merge-queue event yet: the enqueue-settle window (incl. OPEN + CLEAN before the
	// CLEAN → QUEUED flip). Still settling — NEVER an ejection (the #1906 race).
	return at(
		"pending",
		"no merge-queue timeline event yet (enqueue-settle window) — still settling, not ejected",
	);
};

/** One base-branch commit, projected to the two fields the squash predicate reads. */
export interface BaseBranchCommit {
	/** The full commit message; only its subject (first) line is matched. */
	readonly message?: string | undefined;
	/** How many parents the commit has. A squash has exactly one. */
	readonly parents?: number | undefined;
}

/**
 * Does the scanned base-branch window carry PR `pr`'s squash? Two conditions, both required:
 * the commit's **subject line ends with `(#pr)`** — the squash title GitHub's merge queue
 * writes — and it has **exactly one parent**, which is what makes it a squash rather than a
 * merge commit that merely mentions the PR.
 *
 * Ending-anchored, never a substring match: a squash of a PR whose own title cites another
 * issue reads `… (#3924) (#4010)`, so `contains "(#3924)"` would report #3924 as landed. Only
 * the trailing `(#N)` is the PR this commit squashed.
 *
 * `absent` means "not in the scanned window" — never "ejected"; a healthy queued PR reads
 * `absent` too (#4057).
 */
export const squashOnBaseBranch = (
	commits: ReadonlyArray<BaseBranchCommit>,
	pr: number,
): BaseBranchSquash => {
	const suffix = `(#${pr})`;
	const landed = commits.some((commit) => {
		const subject = (commit.message ?? "").split("\n")[0]?.trim() ?? "";
		return subject.endsWith(suffix) && commit.parents === 1;
	});
	return landed ? "landed" : "absent";
};

/**
 * Extract the LAST merge-queue event from a REST issue-timeline array — the authoritative
 * `added_to_merge_queue` / `removed_from_merge_queue` events, last-wins (survives a
 * re-enqueue). Robust to the timeline arriving out of order: prefers each event's
 * `created_at`, falling back to array position when a timestamp is absent. Returns `null`
 * when the timeline carries no merge-queue event (the settle window).
 */
export const lastMergeQueueEvent = (
	timeline: ReadonlyArray<{readonly event?: string; readonly created_at?: string}>,
): LastMergeQueueEvent => {
	// Collect only the merge-queue events (with their original index for the timestamp-tie
	// fallback), then pick the last by (created_at, index) — no mutable-over-closure the
	// checker can't narrow.
	const events = timeline
		.map((entry, idx) => ({event: entry.event, key: entry.created_at ?? "", idx}))
		.filter(
			(
				e,
			): e is {
				event: "added_to_merge_queue" | "removed_from_merge_queue";
				key: string;
				idx: number;
			} => e.event === "added_to_merge_queue" || e.event === "removed_from_merge_queue",
		);
	if (events.length === 0) return null;
	const last = events.reduce((a, b) =>
		b.key > a.key || (b.key === a.key && b.idx > a.idx) ? b : a,
	);
	return last.event;
};

/**
 * Does the REST issue-timeline carry a `merged` event? Presence-only, deliberately order-free: the
 * queue emits `removed_from_merge_queue` and `merged` within a second of each other as it lands the
 * batch, in either array order (#4143 carries `merged` BEFORE the removal at the same second),
 * so "did the merge land" is answered by the event existing, never by its position (#4155).
 */
export const hasMergedEvent = (
	timeline: ReadonlyArray<{readonly event?: string; readonly created_at?: string}>,
): boolean => timeline.some((entry) => entry.event === "merged");
