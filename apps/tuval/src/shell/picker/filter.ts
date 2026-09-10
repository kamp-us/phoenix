/**
 * What the operator's typing leaves standing. Narrowing only — `showsInAWindow` still decides which
 * rows exist at all (`./entries.ts`), and this shrinks that answer without ever widening it.
 *
 * The matcher is the `fzf` package (fzf-for-js), founder-ruled on #8450: the ranking engine is
 * theirs, not ours, so nothing here scores, weights a position or breaks a tie. `selector` reads the
 * row's own `label` and nothing else — a program id, a process id or a parent never reaches the
 * query, which is the ticket's no-go.
 *
 * Both sections are matched separately and kept in that order, so the two groups the frame renders
 * survive the filter; within a section fzf's own descending score is the order.
 */

import {Fzf} from "fzf";
import type {PickerEntries, PickerEntry} from "./entries.ts";

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
				programs: new Fzf(entries.programs, {selector}).find(filter).map((match) => match.item),
				processes: new Fzf(entries.processes, {selector}).find(filter).map((match) => match.item),
			};
