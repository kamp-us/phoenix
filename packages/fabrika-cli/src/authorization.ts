/**
 * The quoted authorization — one shape, for every verb that records an authority a human gave in
 * conversation instead of typing into the artifact himself.
 *
 * A verb that takes one reads a file and posts it verbatim beside the marker it writes. The five
 * clauses below are what "verbatim" has to survive: the file read, a body with nothing in it, a body
 * nothing can place in time, a body that IS a machine-local path, and a body that carries one. Each
 * resolves to a refusal with nothing written, because a marker with a void authorization beside it
 * reads to a careless human as an authority somebody holds.
 *
 * **What a quoted authorization proves, exactly.** That the account invoking the verb posted these
 * bytes and dated them. It does not prove the quote is a truthful record of what the human said, and
 * nothing mechanical can: a relayed authority is indistinguishable from a fabricated one at the point
 * it is recorded. The marker binds the text; the human reading it later binds the truth.
 *
 * The codes are the caller's, because each group seats this fact in its own table
 * (`./exit-code-alignment.ts`) — the check is shared, the numbering is not.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8857#issuecomment-5625302485
 */

import {isBareAtReference, type Leak, renderLeaks, scanBody} from "./report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "./verb.ts";

/** An ISO-8601 date, which is what makes a quoted authorization datable. */
export const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** A file the adapter read for the verb, so the verb itself touches no filesystem. */
export type AuthorizationDocument =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Failed"; readonly reason: string};

/**
 * The seats the calling group gives the three proven refusals. The read failure is `1` everywhere —
 * a path that will not read is a bad invocation, not a proven fact about the authority.
 */
export interface AuthorizationCodes {
	/** Proven: the file is empty, or carries no ISO-8601 date. */
	readonly absent: number;
	/** Proven: the body is a bare `@` path reference — not redactable. */
	readonly bareAt: number;
	/** Proven: the body carries a machine-local path. */
	readonly leaked: number;
}

export type AuthorizationRead =
	| {readonly _tag: "Quoted"; readonly text: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/** The comment body a quoted authorization posts as — trimmed, newline-terminated, never reworded. */
export const authorizationBody = (quoted: string): string => `${quoted.trim()}\n`;

/**
 * Judge one read authorization against the five clauses, in the caller's own words.
 *
 * `subject` names what the authorization would authorize — a ruling, a clearance — so the refusal
 * says which void artifact was refused rather than naming the flag twice.
 */
export const readAuthorization = (
	verb: string,
	subject: string,
	path: string,
	read: AuthorizationDocument,
	codes: AuthorizationCodes,
): AuthorizationRead => {
	if (read._tag === "Failed") {
		return {
			_tag: "Refused",
			outcome: refuse(
				FAILED,
				`${verb}: could not read --authorization ${path}: ${read.reason} — the authorization is UNKNOWN, never empty.`,
			),
		};
	}
	const quoted = read.text;
	if (quoted.trim() === "") {
		return {
			_tag: "Refused",
			outcome: refuse(
				codes.absent,
				`${verb}: --authorization ${path} is empty — a ${subject} with no quoted authorization is void.`,
			),
		};
	}
	if (!ISO_DATE.test(quoted)) {
		return {
			_tag: "Refused",
			outcome: refuse(
				codes.absent,
				`${verb}: --authorization ${path} carries no ISO-8601 date — the authorization must be dated.`,
			),
		};
	}
	if (isBareAtReference(quoted)) {
		return {
			_tag: "Refused",
			outcome: refuse(
				codes.bareAt,
				`${verb}: the authorization is a bare @ path reference — not redactable, refusing to post it.`,
			),
		};
	}
	const leaks = scanBody(quoted);
	const firstLeak: Leak | undefined = leaks.leaks[0];
	if (firstLeak !== undefined) {
		return {
			_tag: "Refused",
			outcome: refuse(
				codes.leaked,
				`${verb}: the authorization carries a machine-local path: ${firstLeak.text} — refusing to post it.`,
				renderLeaks(leaks.leaks),
			),
		};
	}
	return {_tag: "Quoted", text: quoted};
};
