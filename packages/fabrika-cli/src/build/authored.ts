/**
 * The guard over **authored** text — the bytes the caller just wrote — for `build pr` and `build note`.
 *
 * Four outcomes, and the first two must never collapse: an **unread** pipe is UNKNOWN and seats on
 * `1`, a **read-but-empty** one is a proven `3`. Swallowing the first into the second makes an unread
 * pipe byte-identical to an empty one, and the caller then decides over evidence it never saw (#3924).
 * A body that IS a path is `6` rather than `5` because the fixes are opposite: the loop on a leak is
 * *rewrite and resend*, and on a body that is a path that loop never terminates (#3086).
 *
 * **The predicates are the shipped `report/leaks.ts` ones, imported** — a second leak predicate that
 * drifts from the first is worse than either alone. Only the message wording is this group's.
 */
import type {StdinRead} from "../io/stdin.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {BARE_AT_PATH, EMPTY_STDIN, LEAKED_PATH} from "./codes.ts";

export interface AuthoredSurface {
	readonly verb: string;
	/** The whole `3` message — the contract states it per verb, so it is not composed here. */
	readonly emptyMessage: string;
	/** The whole `6` message, for the same reason. */
	readonly bareAtMessage: string;
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
				`${surface.verb}: could not read stdin: ${read.reason} — the body is UNKNOWN, never empty.`,
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

/** The leak refusal for `body`, or `null` when it carries no machine-local path. */
export const leakRefusal = (verb: string, body: string): VerbOutcome | null => {
	const scan = scanBody(body);
	const first = scan.leaks[0];
	if (first === undefined) return null;
	return refuse(
		LEAKED_PATH,
		`${verb}: the body carries a machine-local path: ${first.text} — redact before posting.`,
		renderLeaks(scan.leaks),
	);
};
