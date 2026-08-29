/**
 * The note suppression key: one format, written and read by `heal-ci note`.
 *
 * A strand's history is a history, so `note` posts a new comment per classification — but "per
 * classification" and "per caller" are not the same thing. Two sweeps three minutes apart at one
 * head with one class produced up to six substantively identical notes on a single pull request
 * (#7209), because nothing on either side of the write knew the other had already recorded it.
 * The key `<pr>:<class>:<head>` is what makes the record idempotent: one key earns exactly one note
 * for as long as the pull request is open, and a strand is re-noticed only when its class changes or
 * a new commit lands — the two events that make the earlier note stale.
 *
 * The suppression used to live in `.github/workflows/heal-ci-sweep.yml`'s `run:` block, which built
 * the key, paged the comments and globbed for a hit. That deduped the scheduled path and left every
 * other caller posting bare, and it put the workflow on the wrong side of ADR 0228 — a script
 * deriving a decision rather than relaying a verb's. Moving it here fixes both, and every note path
 * inherits it.
 *
 * It is deliberately **not** `marker.ts`'s shape, and the two readers cannot see
 * each other's marker: this one is an HTML comment matched as a whole line anywhere in the body, the
 * rerun marker is a bare `heal-ci-rerun:` line matched on line one only. A note recording a
 * `RERUN-QUEUED` terminal carries this key and names the same head at the same moment, so an
 * overlapping matcher would read the skill's own narration as the at-most-once rerun marker and
 * refuse every first rerun.
 */

import type {StallToken} from "./stall.ts";

export interface NoteKey {
	readonly pr: number;
	readonly stallClass: string;
	readonly head: string;
}

/**
 * The marker line, anchored. The head is compared as full 40-hex equality, never as a prefix —
 * `marker.ts`'s rule, for `marker.ts`'s reason: a truncated sha prefix-bound to a head it does not
 * equal suppresses a note the current tree has never had one for.
 */
const LINE = /^<!-- heal-ci-note key=(\d+):([a-z-]+):([0-9a-f]{40}) -->$/;

export const renderKey = (key: NoteKey): string =>
	`<!-- heal-ci-note key=${key.pr}:${key.stallClass}:${key.head} -->`;

export const keyOf = (pr: number, stallClass: StallToken, head: string): NoteKey => ({
	pr,
	stallClass,
	head,
});

export const sameKey = (a: NoteKey, b: NoteKey): boolean =>
	a.pr === b.pr && a.stallClass === b.stallClass && a.head === b.head;

/**
 * Read the key off a comment body — **any one whole line**, never a substring.
 *
 * Whole-line rather than first-line because the note's first line is the skill's fixed
 * `heal-ci: <terminal> — PR #<n> @ <sha> → <lane>` signal line, which every receiver parses; the
 * machine marker rides below it rather than displacing it. Whole-line rather than substring because
 * a substring search matches the key quoted inside a human's reply, and suppressing on somebody's
 * quotation is how a real strand goes unrecorded.
 */
export const readKey = (body: string): NoteKey | null => {
	for (const line of body.split("\n")) {
		const matched = LINE.exec(line.trim());
		if (matched?.[1] === undefined || matched[2] === undefined || matched[3] === undefined) {
			continue;
		}
		return {pr: Number.parseInt(matched[1], 10), stallClass: matched[2], head: matched[3]};
	}
	return null;
};

/** The first comment already carrying exactly this key, or `null` when the whole history is clear. */
export const keyBoundTo = (
	bodies: ReadonlyArray<{readonly body: string; readonly id: number}>,
	key: NoteKey,
): {readonly id: number} | null => {
	for (const comment of bodies) {
		const carried = readKey(comment.body);
		if (carried !== null && sameKey(carried, key)) return {id: comment.id};
	}
	return null;
};

/** The posted body: the authored note, then the machine marker as its last line. */
export const withKey = (authored: string, key: NoteKey): string =>
	`${authored.replace(/\n+$/, "")}\n\n${renderKey(key)}\n`;
