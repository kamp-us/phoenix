/**
 * `adr next`'s allocation, pure: the id is `max(union) + 1`, never the first free number in it.
 *
 * A gap below the maximum is a number some pull request claimed and never merged, and re-issuing
 * it points every citation of the abandoned ADR at a different decision. This departs from the
 * older "first integer free" wording and follows every implementation since; reconciling the two is
 * a corpus question, not this package's to resolve.
 *
 * The union has three members, not two. The third is the ids claimed on a branch with no pull
 * request behind it — an epic child's mint, which neither of the other two can see for the whole
 * life of a phase (`branch-claims.ts`).
 */

/** How many digits an id zero-pads to — the width every existing record already carries. */
export const ID_WIDTH = 4;

/** Zero-pad a numeric id to {@link ID_WIDTH}. */
export const padId = (n: number): string => String(n).padStart(ID_WIDTH, "0");

/** The numeric part of an `NNNN[a]` id, or `null` when it has none. */
const numericOf = (id: string): number | null => {
	const m = /^(\d+)[a-z]*$/i.exec(id);
	return m?.[1] === undefined ? null : Number.parseInt(m[1], 10);
};

export interface Allocation {
	/** The allocated id, zero-padded. */
	readonly id: string;
	/** The highest id already merged on the base ref, zero-padded. */
	readonly mergedMax: string;
	/** The ids open pull requests already claim, ascending. */
	readonly inFlight: ReadonlyArray<string>;
	/** The ids claimed on a branch ref with no pull request behind it, ascending. */
	readonly branchClaims: ReadonlyArray<string>;
}

/** Numeric ids, deduplicated and ascending — the reported form of either claim set. */
const reported = (ns: ReadonlyArray<number>): ReadonlyArray<string> =>
	[...new Set(ns)].sort((a, b) => a - b).map(padId);

/**
 * Allocate the next id from the merged set unioned with the in-flight and branch-claim sets.
 *
 * All three inputs are *facts*: the caller refuses on any set it could not read, so an empty one
 * reaching here means "nothing there", never "the read failed". Three empty sets are the
 * fresh-adopter case and allocate `0001` (see `base-ref.ts`).
 */
export const allocate = (
	mergedIds: ReadonlyArray<string>,
	inFlightIds: ReadonlyArray<string>,
	branchIds: ReadonlyArray<string>,
): Allocation => {
	const merged = mergedIds.map(numericOf).filter((n): n is number => n !== null);
	const inFlight = inFlightIds.map(numericOf).filter((n): n is number => n !== null);
	const branch = branchIds.map(numericOf).filter((n): n is number => n !== null);
	const mergedMax = merged.reduce((a, b) => (b > a ? b : a), 0);
	const unionMax = [...merged, ...inFlight, ...branch].reduce((a, b) => (b > a ? b : a), 0);
	return {
		id: padId(unionMax + 1),
		mergedMax: padId(mergedMax),
		inFlight: reported(inFlight),
		branchClaims: reported(branch),
	};
};
