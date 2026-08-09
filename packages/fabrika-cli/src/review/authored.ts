/**
 * The guard over **authored** text — the bytes the caller just wrote — for `review post` and
 * `review append-criterion`.
 *
 * Four outcomes, and the first two must never collapse: an **unread** pipe is UNKNOWN and seats on
 * `1`, a **read-but-empty** one is a proven `3`. Swallowing the first to the second makes an unread
 * pipe byte-identical to an empty one, and the caller then decides over evidence it never saw
 * (#3924). A body that IS a path is `6` rather than `5` because the fixes are opposite — the loop on
 * a leak is *rewrite and resend*, and on a body that is a path that loop never terminates.
 *
 * **The predicates are the shipped `report/leaks.ts` ones, imported.** Only the message text is this
 * group's, because each refusal names one correctable thing in this verb's own words — a verdict body
 * that must *cite* a leak found in the diff cites it by class root or repo-relative form, while an
 * appended criterion is simply rewritten (#3785). A second leak predicate that drifts from the first
 * is worse than either alone.
 */

import type {StdinRead} from "../io/stdin.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {BARE_AT_PATH, EMPTY_STDIN, LEAKED_PATH} from "./codes.ts";

/** What one verb calls the text it is guarding, so each refusal reads as that verb's own. */
export interface AuthoredSurface {
	readonly verb: string;
	/** The noun a `1` and a `5` refusal name, e.g. `the assembled comment`. */
	readonly noun: string;
	/** The whole `3` message — the contract states it per verb, so it is not composed here. */
	readonly emptyMessage: string;
	/** The whole `6` message, for the same reason. */
	readonly bareAtMessage: string;
	/** The correction a leak refusal ends with, e.g. `cite it repo-relative or by class root.` */
	readonly leakCorrection: string;
}

export type Authored =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Text"; readonly text: string; readonly bytes: number};

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
			outcome: refuse(EMPTY_STDIN, surface.emptyMessage, [
				`${surface.verb}: stdin was read and held ${bytes} byte(s).`,
			]),
		};
	}
	if (isBareAtReference(text)) {
		return {_tag: "Refused", outcome: refuse(BARE_AT_PATH, surface.bareAtMessage)};
	}
	return {_tag: "Text", text, bytes};
};

/**
 * The leak refusal for `body`, or `null` when it carries no machine-local path.
 *
 * Run over the **composed** artifact rather than over raw stdin, so nothing a verb itself appends can
 * escape the predicate. The message names the first hit because a refusal names one correctable
 * thing; every hit is listed above it, so one round clears them all.
 */
export const leakRefusal = (surface: AuthoredSurface, body: string): VerbOutcome | null => {
	const scan = scanBody(body);
	const first = scan.leaks[0];
	if (first === undefined) return null;
	return refuse(
		LEAKED_PATH,
		`${surface.verb}: ${surface.noun} carries a machine-local path at line ${first.line} (${first.class}) — ${surface.leakCorrection}`,
		renderLeaks(scan.leaks),
	);
};
