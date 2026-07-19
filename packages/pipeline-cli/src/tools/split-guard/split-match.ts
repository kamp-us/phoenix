/**
 * The pure match core for `split-guard` (#3464): the create-once key that makes the
 * `triage` skill's Step-3 "Split bundled reports" child-create idempotent.
 *
 * The observed defect (#3462/#3463): a single split of a parent emitted two byte-identical
 * children 5s apart because nothing keyed the child-create on a durable signal — a retry or a
 * re-emit produced a redundant twin. The durable idempotency signal is the `split from #<parent>`
 * back-reference every split child already carries (triage Step 3.4 "Cross-link"): a second run
 * finds the first child by that back-ref and skips the POST.
 *
 * IO-free by construction. `referencesParent` tests the durable back-ref; `unitKey` normalizes a
 * title into a stable slug so the match survives whitespace/case/punctuation churn WITHOUT relying
 * on byte-equality of the body (#3464 AC2 — a twin emitted with a slightly different body is still
 * caught, because the key is (parent back-ref + title slug), never the body text). `github.ts`
 * feeds this raw REST rows from the read-after-write `needs-triage` queue.
 */

/** A minimal open-issue row — number + title + body, the three fields the match needs. */
export interface ChildRef {
	readonly number: number;
	readonly title: string;
	readonly body: string;
}

/**
 * Does `body` carry a `split from #<parent>` back-reference to `parent`? This is the durable
 * create-once key (triage Step 3.4 stamps it on every split child). Matched emphasis-/case-tolerant
 * and only on the exact number (a `#12` boundary guard so `#12` never matches `#123`).
 */
export const referencesParent = (body: string, parent: number): boolean =>
	new RegExp(`split\\s+from\\s+#${parent}(?![0-9])`, "i").test(body);

/**
 * Normalize a title into a stable unit-key: lowercase, split on any non-alphanumeric run, drop
 * empties, join with `-`. Order-preserving so two genuinely different siblings of the same parent
 * (`split from #N` on each, but distinct units) keep distinct keys and are never collapsed — the
 * key only absorbs whitespace/case/punctuation churn, not a real change of unit. A byte-identical
 * twin (the #3462/#3463 case) and a whitespace-/case-variant twin both map to the same key.
 */
export const unitKey = (title: string): string =>
	title
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0)
		.join("-");

/**
 * The create-once decision: among `existing` open children, return the number of one that already
 * covers `(parent, proposedTitle)` — it back-references `parent` AND shares the proposed title's
 * unit-key — or `undefined` when none does (safe to create). The lowest such number is returned so
 * the survivor is deterministic (the earliest-created child wins, mirroring the #3461→#3462 canonical
 * survivor). A non-undefined result means "reuse this child, do NOT POST a second."
 */
export const findExistingChild = (
	parent: number,
	proposedTitle: string,
	existing: ReadonlyArray<ChildRef>,
): number | undefined => {
	const key = unitKey(proposedTitle);
	// An all-punctuation / empty proposed title has no discriminating key — refuse to match on it
	// rather than collapse every keyless child together (fail-open to create, never a false reuse).
	if (key.length === 0) return undefined;
	return existing
		.filter((c) => referencesParent(c.body, parent) && unitKey(c.title) === key)
		.map((c) => c.number)
		.sort((a, b) => a - b)[0];
};
