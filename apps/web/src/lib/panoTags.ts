/**
 * The pano tag vocabulary — one home for the kinds, their CSS modifier, and the
 * legacy English aliases, so SPA/server drift is a type error rather than a silent ship.
 *
 * Tags are stored verbatim (the Turkish kind) as CSV on `post_record.tags`; the English
 * aliases are normalization-only, for legacy seed values. Keep this module free of
 * React, worker and DB imports — the worker tsconfig cross-includes it.
 */

export const POST_TAG_KINDS = ["göster", "tartışma", "soru", "söylenme", "meta"] as const;

export type PostTagKind = (typeof POST_TAG_KINDS)[number];

/** `kp-tag--<cls>` — the English alias doubles as the styling key. */
export const POST_TAG_CLASS: Record<PostTagKind, string> = {
	göster: "show",
	tartışma: "discuss",
	soru: "ask",
	söylenme: "rant",
	meta: "meta",
};

/** The canonical kinds map to themselves so label resolution stays one lookup. */
const TAG_ALIASES: Record<PostTagKind, PostTagKind> & Record<string, PostTagKind> = {
	göster: "göster",
	tartışma: "tartışma",
	soru: "soru",
	söylenme: "söylenme",
	meta: "meta",
	show: "göster",
	discuss: "tartışma",
	ask: "soru",
	rant: "söylenme",
};

const ALLOWED: ReadonlySet<string> = new Set(POST_TAG_KINDS);

export function isPostTagKind(kind: string): kind is PostTagKind {
	return ALLOWED.has(kind);
}

/** An unknown kind falls back to its raw value so it still renders. */
export function tagLabel(kind: string): string {
	return TAG_ALIASES[kind] ?? kind;
}

/** An unknown kind falls back to `meta`, the neutral styling. */
export function tagClass(kind: string): string {
	const resolved = TAG_ALIASES[kind];
	return resolved ? POST_TAG_CLASS[resolved] : "meta";
}
