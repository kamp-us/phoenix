/**
 * What a PR body says about a linked issue — read as a **fact**, never as a requirement.
 *
 * A conversation-authored doc or ADR PR may legitimately carry no linked issue (ADR 0075), and
 * minting one to satisfy a link guard is banned outright, so `none` is a well-formed answer. Only
 * `linkage-refused` — a body that reaches for a reference form the merge seam does not recognise —
 * is a stall class, and it needs the *other* forms named to be detectable at all.
 */
import {linkedIssueOf} from "../review/classes.ts";

export type LinkKind = "fixes" | "part-of" | "other" | "none";

export interface Link {
	readonly kind: LinkKind;
	readonly number: number | null;
}

const PART_OF = /\bpart of\b[ \t]*:?[ \t]*#(\d+)/i;
/** The banned spellings, plus a bare `#N` — every form that links visibly and closes nothing. */
const OTHER_REFERENCE = /(?:\bre\b[ \t]*:|\brefs?\b|\bsee\b)[ \t]*#\d+|#\d+/i;

export const linkOf = (body: string): Link => {
	const fixes = linkedIssueOf(body);
	if (fixes !== null) return {kind: "fixes", number: fixes};
	const partOf = PART_OF.exec(body);
	if (partOf?.[1] !== undefined) {
		return {kind: "part-of", number: Number.parseInt(partOf[1], 10)};
	}
	return OTHER_REFERENCE.test(body) ? {kind: "other", number: null} : {kind: "none", number: null};
};

/** The line grammar's `link` field: the kind, with its number where it has one. */
export const renderLink = (link: Link): string =>
	link.number === null ? link.kind : `${link.kind}:${link.number}`;
