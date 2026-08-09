/**
 * The §CP advisory carrier: a first line that withholds the SHA, and a canonical body line that
 * carries it.
 *
 * The shape is ADR 0151's, reimplemented here rather than called (ADR 0238). Its whole point is that
 * the two tokens are **distinct**: the first line stays SHA-less so an advisory can never be read as
 * an auto-mergeable `PASS @ <sha>` marker (ADR 0111 preserved), while `Reviewed-head: @ <sha>` in the
 * body records the head that was actually inspected. ADR 0226 makes the carrier PASS-only — a §CP
 * FAIL posts the ordinary FAIL marker — which `review post` enforces on `10`.
 */
import {CLAUSE_SEPARATOR, type HeadSha, headSha} from "../wire/verdict-marker.ts";

/** The advisory first line: the namespace, the fixed `advisory` token, and the human clause. */
export const emitAdvisory = (namespace: string, clause: string): string =>
	`${namespace}: advisory ${CLAUSE_SEPARATOR} ${clause}\n`;

/** The canonical body line ADR 0151 pins. Emitted verbatim; a drifted prefix is not this line. */
export const reviewedHeadLine = (sha: string): string => `Reviewed-head: @ ${sha}`;

const FIRST_LINE = /^\s*\*{0,2}\s*(review(?:-[a-z0-9]+)*)\s*:\s*\*{0,2}\s*advisory\b/i;
/** ADR 0151's anchored matcher — the `Reviewed-head:` prefix, hyphen and all, at a line's start. */
const REVIEWED_HEAD = /^[ \t]*Reviewed-head:[ \t]*@?[ \t]*([0-9a-f]{7,40})\b/im;

export interface AdvisoryCarrier {
	readonly namespace: string;
	readonly sha: HeadSha;
}

const firstNonBlankLine = (body: string): string =>
	body.split("\n").find((line) => line.trim() !== "") ?? "";

/**
 * The advisory carrier a comment body holds, or `null`.
 *
 * Both halves are required: an advisory first line with no `Reviewed-head:` records no head, and a
 * `Reviewed-head:` under an ordinary marker is not an advisory. Returning `null` for either is what
 * keeps a half-formed advisory reaching the caller as a `malformed` row rather than as a verdict.
 */
export const readAdvisory = (body: string): AdvisoryCarrier | null => {
	const first = FIRST_LINE.exec(firstNonBlankLine(body));
	if (first?.[1] === undefined) return null;
	const bound = REVIEWED_HEAD.exec(body);
	const sha = bound?.[1] === undefined ? null : headSha(bound[1]);
	return sha === null ? null : {namespace: first[1].toLowerCase(), sha};
};
