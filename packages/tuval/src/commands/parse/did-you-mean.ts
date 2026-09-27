/**
 * The one suggestion a refusal carries.
 *
 * Levenshtein distance under a bound that grows with the typed word, and nothing outside the bound
 * is offered at all: a wrong guess costs a reader more than silence. Shared by the parser's
 * refusals, the executor's `UnknownSpell` and the key bindings' errors, so one typo reads the same
 * wherever it is caught.
 */

const boundFor = (candidate: string): number => (candidate.length <= 3 ? 1 : 2);

// Every index the matrix reads is inside its row by construction; the fallback never fires and is
// here so the loop reads without a non-null assertion at each cell.
const cell = (row: ReadonlyArray<number>, index: number): number => row[index] ?? 0;

const distance = (a: string, b: string, limit: number): number => {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({length: b.length + 1}, (_, index) => index);
	for (let row = 1; row <= a.length; row++) {
		const current = [row];
		let best = row;
		for (let column = 1; column <= b.length; column++) {
			const substitution =
				cell(previous, column - 1) + (a.charAt(row - 1) === b.charAt(column - 1) ? 0 : 1);
			const value = Math.min(
				cell(current, column - 1) + 1,
				cell(previous, column) + 1,
				substitution,
			);
			current.push(value);
			if (value < best) best = value;
		}
		// Every path through the remaining rows costs at least this row's cheapest cell, so once that
		// exceeds the limit no completion of the matrix can come back under it.
		if (best > limit) return limit + 1;
		previous = current;
	}
	return cell(previous, b.length);
};

/** The closest choice within the bound, or nothing. Ties go to the earlier choice. */
export const didYouMean = (
	candidate: string,
	choices: ReadonlyArray<string>,
): string | undefined => {
	const limit = boundFor(candidate);
	let best: string | undefined;
	let bestDistance = limit + 1;
	for (const choice of choices) {
		const measured = distance(candidate, choice, limit);
		if (measured < bestDistance) {
			best = choice;
			bestDistance = measured;
		}
	}
	return bestDistance <= limit ? best : undefined;
};
