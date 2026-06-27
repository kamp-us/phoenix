/**
 * `Level` — an ordered scale with `gte`, the RBAC/MLS-shaped axis backing the
 * earned-authorship ladder (ADR 0107 §4): a {@link Scale} is a list of rank
 * names whose only operation is monotone comparison (a yazar passes any
 * çaylak-floored gate). Vocab-free — the rank names are caller-supplied
 * (`features/kunye` passes `["visitor", "çaylak", "yazar"]`); the `const` scale
 * pins the name literals so `min`/comparison args are checked against the real
 * ladder, not bare `string`.
 */

/** An ordered scale of rank `Name`s, lowest-first, with monotone comparison. */
export interface Scale<Name extends string> {
	/** The rank names, lowest-authority first. */
	readonly order: ReadonlyArray<Name>;
	/** The 0-based rank of a name (its index in {@link order}). */
	readonly rank: (name: Name) => number;
	/** Is `a` at least as high as `b` on the scale? The ladder's whole law. */
	readonly gte: (a: Name, b: Name) => boolean;
	/** Narrow an arbitrary string to a known rank of this scale. */
	readonly has: (name: string) => name is Name;
}

/**
 * Build a {@link Scale} from its rank names, **lowest-authority first**. The
 * `const` type parameter pins the literal names so a capability's `min` and the
 * standing it compares are checked against the real ladder.
 */
export const Scale = <const Names extends ReadonlyArray<string>>(
	order: Names,
): Scale<Names[number]> => {
	const index = new Map<string, number>(order.map((name, i) => [name, i]));
	const rank = (name: Names[number]): number => index.get(name) ?? -1;
	return {
		order,
		rank,
		gte: (a, b) => rank(a) >= rank(b),
		has: (name): name is Names[number] => index.has(name),
	};
};
