/**
 * A session as one palette row: the order they come in, the copy each one carries, and what the
 * filter box matches. Pure, so the three things the window is judged on are testable without a DOM.
 *
 * **An absent field renders as absent.** `SessionRow`'s four optional keys are optional because a
 * real store leaves them out (`../../protocol/session-list.ts`), and the whole point of that shape
 * is lost if a row prints `0 messages` for a store that reported no count or an empty folder for one
 * that reported no path. So every field here is dropped from the line when it is missing, and the
 * one field that has nowhere to be dropped from — the row's own label — says the absence out loud.
 */

import type {CommandPaletteItem} from "@kampus/design";
import type {SessionRow} from "../../protocol/session-list.ts";

/** What the label says when the store reported no first prompt. Named, not blank, and not invented. */
export const NO_FIRST_PROMPT = "(no first prompt)";

/**
 * What a row is called: the store's display title, else the first prompt, else the absence said out
 * loud. Title first is the founder's ruling of 2026-09-07 on #8135 — a session the operator named is
 * the one that should list under the name he chose. It reconciles with #8070 ruling 6 by leaving the
 * first prompt as the label of every session nobody named.
 *
 * Exported because the transcript header names the same session, and two spellings of one label is
 * how a row and the pane it opens come to disagree about which session you clicked.
 */
export const sessionLabel = (session: SessionRow): string =>
	session.title ?? session.firstPrompt ?? NO_FIRST_PROMPT;

/**
 * Two sessions from two backends can carry one `sessionId` — the id is each store's own — so the
 * row's key is the pair. `CommandPalette` keys its options on `value`, and two rows sharing one key
 * is a React list that drops a row silently. The pair is keyed on `programId` rather than the
 * backend tag, because the tag is a label two rows could share and the id is the one that cannot.
 */
export const rowValue = (session: SessionRow): string =>
	`${session.programId}:${session.sessionId}`;

/**
 * Newest first by last modified (ruling 6). The kernel already sorts the union
 * (`../session-list.ts`), and this sorts again rather than trusting it: the window renders whatever
 * list it is handed, including a test's and a future caller's, and an out-of-order list is not a
 * thing an operator can see is wrong.
 */
export const newestFirst = (sessions: ReadonlyArray<SessionRow>): ReadonlyArray<SessionRow> =>
	[...sessions].sort((a, b) => b.lastModified - a.lastModified);

const relative = new Intl.RelativeTimeFormat("en", {numeric: "auto"});

const UNITS = [
	["second", 1000],
	["minute", 60_000],
	["hour", 3_600_000],
	["day", 86_400_000],
	["week", 604_800_000],
	["month", 2_592_000_000],
	["year", 31_536_000_000],
] as const;

/**
 * "3 hours ago", against a `now` the caller owns. The caller owns it because a clock read inside a
 * render is a value no test can pin and no two renders agree on.
 */
export const lastModifiedLabel = (millis: number, now: number): string => {
	const elapsed = millis - now;
	const magnitude = Math.abs(elapsed);
	let unit: Intl.RelativeTimeFormatUnit = "second";
	let size = 1000;
	for (const [candidate, candidateSize] of UNITS) {
		if (magnitude < candidateSize) break;
		unit = candidate;
		size = candidateSize;
	}
	return relative.format(Math.trunc(elapsed / size), unit);
};

const messageCountLabel = (count: number): string =>
	count === 1 ? "1 message" : `${count} messages`;

/**
 * The meta line under the prompt: last modified, folder, branch, message count, backend tag — the
 * five fields of ruling 6 that are not the prompt itself, in that order, with the absent ones gone.
 */
export const sessionDescription = (session: SessionRow, now: number): string =>
	[
		lastModifiedLabel(session.lastModified, now),
		session.folder,
		session.branch,
		session.messageCount === undefined ? undefined : messageCountLabel(session.messageCount),
		session.backend,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");

/** One session as the palette's row. `keywords` is not the filter — `matchesQuery` below is. */
export const sessionItem = (session: SessionRow, now: number): CommandPaletteItem => ({
	value: rowValue(session),
	label: sessionLabel(session),
	description: sessionDescription(session, now),
});

export const sessionItems = (
	sessions: ReadonlyArray<SessionRow>,
	now: number,
): ReadonlyArray<CommandPaletteItem> =>
	newestFirst(sessions).map((session) => sessionItem(session, now));

/**
 * What the filter box matches: the label, folder and branch (ruling 7), and nothing else. The
 * backend tag and the timestamp are deliberately outside it — typing `claude` should find a session
 * whose prompt says claude, not every session Claude happens to own.
 *
 * The label rather than the first prompt, so the box matches what the operator can see: a renamed
 * session filtered on its hidden first prompt is a row that vanishes when you type its own name
 * (#8135). `sessionLabel`'s fallback is not matched — the absence copy is the window's word, not the
 * store's, so typing it would find every unnamed session by accident.
 */
export const matchesQuery = (session: SessionRow, query: string): boolean => {
	const needle = query.trim().toLocaleLowerCase();
	if (needle === "") return true;
	return [session.title ?? session.firstPrompt, session.folder, session.branch].some((field) =>
		field?.toLocaleLowerCase().includes(needle),
	);
};
