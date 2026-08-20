/**
 * The two shapes an evidence-array collapses to before it reaches the answer channel (ADR 0308).
 *
 * A verb's output field is either an **answer-array** — a skill instructs its reader to iterate the
 * rows — or an **evidence-array**, cited only so a short or empty answer is auditable, with no skill
 * reading its rows by name. Answer-arrays stay whole. An evidence-array collapses here: to a reason
 * histogram when its rows carry a small fixed vocabulary, or to a cap-and-count when they do not.
 *
 * It lives beside `./verb.ts` rather than inside it because that module owns the answer channel and
 * takes an already-serialized string; shaping the payload happens before serialization and is a
 * different concern. The five private tallies in the package (`spend/rollup.ts`, `ci/changelog.ts`,
 * `map/frontier.ts`, `governance/roots.ts`, `review/classes.ts`) are each shape-specific and stay
 * where they are — none is generic over rows plus a key function.
 *
 * Both functions are pure and total, so a collapse is as testable as the rows it replaces.
 */

/** A reason and how many rows carried it. Key order is fixed by {@link reasonHistogram}. */
export type ReasonHistogram = Readonly<Record<string, number>>;

/**
 * Tally `rows` by the reason `keyOf` reads off each one.
 *
 * **Key order is count-descending, ties broken by reason ascending — never insertion order.** The
 * histogram is serialized straight into a JSON payload, where key order is the byte order a reader
 * and a golden fixture both see; deriving it from the rows would make the same tally print two ways
 * depending on which issue the board listed first.
 *
 * An empty `rows` gives `{}`, which is the honest answer — a caller reads "no rows were excluded"
 * off it exactly as it would off an empty array.
 */
export const reasonHistogram = <A>(
	rows: Iterable<A>,
	keyOf: (row: A) => string,
): ReasonHistogram => {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = keyOf(row);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return Object.fromEntries(
		[...counts].sort(([leftKey, leftCount], [rightKey, rightCount]) =>
			leftCount === rightCount ? leftKey.localeCompare(rightKey) : rightCount - leftCount,
		),
	);
};

/** The first `cap` rows of an evidence-array, plus how many the collapse dropped. */
export interface CapAndCount<A> {
	readonly rows: ReadonlyArray<A>;
	/** Rows beyond the cap. `0` means the array is whole and nothing was dropped. */
	readonly more: number;
}

/**
 * Keep the first `cap` rows and count the rest — the collapse for an evidence-array whose rows carry
 * no small reason vocabulary to tally.
 *
 * `more` is always present, `0` included, so a reader never has to tell "the field was capped at
 * exactly its length" from "the field is missing its remainder" — the two used to look identical
 * whenever the cap happened to land on the row count.
 *
 * A `cap` that is not a whole number at or above zero keeps nothing and counts everything: a
 * miscomputed cap must never widen the payload past what the caller asked for.
 */
export const capAndCount = <A>(rows: ReadonlyArray<A>, cap: number): CapAndCount<A> => {
	const kept = Number.isInteger(cap) && cap > 0 ? Math.min(cap, rows.length) : 0;
	return {rows: rows.slice(0, kept), more: rows.length - kept};
};
