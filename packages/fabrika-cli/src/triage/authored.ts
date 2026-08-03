/**
 * The guard over **authored** text — the bytes the caller just wrote — shared by `triage split`,
 * `triage enrich`, `triage park` and `triage kill`.
 *
 * All four take their text on stdin only and refuse the same three ways: an unread pipe is UNKNOWN,
 * a read-but-empty one is `3`, a body that IS a path is `6`, and a machine-local path in it is `5`.
 * Only the nouns differ, so the nouns are the parameter and the decisions are here — a second copy
 * per verb is four chances for the refusals to drift apart.
 *
 * **The asymmetry this module encodes:** authored text is *refusable* because its author can fix it.
 * Foreign content a verb copies forward is redacted instead, because refusing it would strand the
 * operation on somebody else's mistake. Redaction is therefore deliberately absent here.
 *
 * The predicate itself is imported from `../report/leaks.ts` rather than re-derived: a second leak
 * predicate that drifts from the first is worse than either alone.
 */

import type {StdinRead} from "../io/stdin.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {BARE_AT_PATH, EMPTY_STDIN, LEAKED_PATH} from "./codes.ts";

/** What one verb calls the text it is guarding, so the refusals read as that verb's own. */
export interface AuthoredSurface {
	/** The verb's full name, e.g. `triage split` — every message leads with it. */
	readonly verb: string;
	/** The noun a refusal names, e.g. `the child body`. */
	readonly noun: string;
	/** The correction an empty read gets, e.g. `pipe the child body in.` */
	readonly emptyHint: string;
}

export type Authored =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	/** The authored text, and the byte count a scope line reports. */
	| {readonly _tag: "Text"; readonly text: string; readonly bytes: number};

/**
 * Resolve stdin into authored text, or the refusal that stops the verb.
 *
 * A **failed** read seats on `1` rather than on {@link EMPTY_STDIN}: an unread pipe is byte-identical
 * to an empty one only if the reader is willing to say so, and a verb that creates issues must not be
 * (#3924). A TTY with nothing piped never reached a read, but its correction is the same as an empty
 * pipe's — send the body — so it joins the empty case.
 */
export const readAuthored = (surface: AuthoredSurface, read: StdinRead): Authored => {
	if (read._tag === "Failed") {
		return {
			_tag: "Refused",
			outcome: refuse(
				FAILED,
				`${surface.verb}: could not read stdin: ${read.reason} — ${surface.noun} is UNKNOWN, never empty.`,
			),
		};
	}
	const text = read._tag === "NoStdin" ? "" : read.text;
	const bytes = new TextEncoder().encode(text).length;
	if (text.trim() === "") {
		return {
			_tag: "Refused",
			outcome: refuse(EMPTY_STDIN, `${surface.verb}: no body on stdin — ${surface.emptyHint}`, [
				`${surface.verb}: stdin was read and held ${bytes} byte(s).`,
			]),
		};
	}
	if (isBareAtReference(text)) {
		return {
			_tag: "Refused",
			outcome: refuse(
				BARE_AT_PATH,
				`${surface.verb}: ${surface.noun} is a bare "@" path reference — the body never arrived. Send it on stdin.`,
			),
		};
	}
	return {_tag: "Text", text, bytes};
};

/**
 * The leak refusal for `body`, or `null` when it carries no machine-local path.
 *
 * Callers run this over the **composed** body rather than over raw stdin, so nothing a verb itself
 * appends can escape the predicate — the same ordering `report file` uses. The message names the
 * first hit because a refusal names one correctable thing; every hit is listed above it.
 */
export const leakRefusal = (surface: AuthoredSurface, body: string): VerbOutcome | null => {
	const scan = scanBody(body);
	const first = scan.leaks[0];
	if (first === undefined) return null;
	return refuse(
		LEAKED_PATH,
		`${surface.verb}: ${surface.noun} carries a machine-local path at line ${first.line} (${first.class}) — rewrite it repo-relative.`,
		renderLeaks(scan.leaks),
	);
};
