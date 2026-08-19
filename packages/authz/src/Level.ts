/**
 * `Level` — the ordered scale backing the earned-authorship ladder (ADR 0107 §4).
 * Vocab-free: rank names are caller-supplied (`features/kunye` passes
 * `["visitor", "çaylak", "yazar"]`).
 */

export interface Scale<Name extends string> {
	/** The rank names, **lowest-authority first**. */
	readonly order: ReadonlyArray<Name>;
	readonly rank: (name: Name) => number;
	readonly gte: (a: Name, b: Name) => boolean;
	readonly has: (name: string) => name is Name;
}

/**
 * Build a {@link Scale} from its rank names, **lowest-authority first**. The
 * `const` type parameter pins the literal names so a capability's `min` and the
 * standing it compares are checked against the real ladder, not bare `string`.
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
