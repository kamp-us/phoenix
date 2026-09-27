/**
 * What the operator's typing leaves standing. Narrowing only — `showsInAWindow` still decides which
 * rows exist at all (`./entries.ts`), and this shrinks that answer without ever widening it.
 *
 * The matcher is the `fzf` package (fzf-for-js), founder-ruled on #8450: the ranking engine is
 * theirs, not ours, so nothing here scores, weights a position or breaks a tie. `selector` reads the
 * row's own `label` and nothing else — a program id, a process id or a parent never reaches the
 * query, which is the ticket's no-go.
 *
 * Both sections are matched separately and kept in that order, and so are the groups inside the
 * programs section, so every group the frame renders survives the filter; within a group fzf's own
 * descending score is the order.
 */

import {Fzf} from "fzf";
import {groupKeyOf, type PickerEntries, type PickerEntry} from "./entries.ts";

/**
 * The filter as the view stores it. `null` is the picker with no filter open at all — the state
 * every mount starts in (ruling Q3) — and a string is an open filter, empty included.
 */
export type PickerFilter = string | null;

const selector = (entry: PickerEntry): string => entry.label;

/**
 * The rows a filter leaves. A closed or empty filter is the whole list in its own order rather than
 * fzf's: an empty query scores every row alike, and re-ordering a list nobody narrowed would move
 * the highlight under an operator who only pressed `/`.
 */
export const visibleEntries = (entries: PickerEntries, filter: PickerFilter): PickerEntries =>
	filter === null || filter === ""
		? entries
		: {
				programs: grouped(
					entries.programs,
					new Fzf(entries.programs, {selector}).find(filter).map((match) => match.item),
				),
				processes: new Fzf(entries.processes, {selector}).find(filter).map((match) => match.item),
			};

/**
 * Does `label` survive `filter`? The same matcher over one row, for a row that sits in no section:
 * "Open project…" (#9697), and each row of its steps.
 */
export const matchesFilter = (label: string, filter: PickerFilter): boolean =>
	filter === null || filter === "" || new Fzf([label]).find(filter).length > 0;

/**
 * `rows` narrowed by `filter`, each group kept in its own place and fzf's order inside it: what the
 * "Open project…" steps list (#9697). A closed or empty filter is `rows` as they stand.
 */
export const narrowRows = <R>(
	rows: ReadonlyArray<R>,
	filter: PickerFilter,
	label: (row: R) => string,
	group: (row: R) => string,
): ReadonlyArray<R> => {
	if (filter === null || filter === "") return rows;
	// fzf types its options off the item type, which a type parameter leaves undecided, so it ranks
	// each row's label beside its index and the rows are read back through the index.
	const labelled = rows.map((row, index) => ({index, label: label(row)}));
	const matched = new Fzf(labelled, {selector: (item) => item.label})
		.find(filter)
		.flatMap((match) => {
			const row = rows[match.item.index];
			return row === undefined ? [] : [row];
		});
	return inGroupOrder(rows, matched, group);
};

/**
 * `matched` put back into the groups `all` lists them in (#9694): a query like `claude` matches one
 * entry per project, and fzf's score alone would interleave the projects. A stable sort by the
 * group's first position keeps fzf's order inside each group and the groups in their own order.
 */
const grouped = <E extends PickerEntry>(
	all: ReadonlyArray<E>,
	matched: ReadonlyArray<E>,
): ReadonlyArray<E> => inGroupOrder(all, matched, groupKeyOf);

const inGroupOrder = <R>(
	all: ReadonlyArray<R>,
	matched: ReadonlyArray<R>,
	group: (row: R) => string,
): ReadonlyArray<R> => {
	const rank = new Map<string, number>();
	for (const row of all) {
		const key = group(row);
		if (!rank.has(key)) rank.set(key, rank.size);
	}
	const rankOf = (row: R): number => rank.get(group(row)) ?? rank.size;
	return [...matched].sort((a, b) => rankOf(a) - rankOf(b));
};
