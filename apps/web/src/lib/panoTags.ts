/**
 * The pano **tag** vocabulary — the single home for the closed set of post
 * tags, their CSS-modifier class, and the legacy English aliases.
 *
 * A plain-string/const module (no React, no worker, no DB import) cross-included
 * by the worker tsconfig, so the server allow-list (`Pano.ts`), the SPA submit
 * form (`PanoSubmitPage.tsx`), and the card renderers (`Tag`) all name the same
 * five kinds and the same kind→class map. One home per kind means SPA-vs-server
 * drift is a type error, not a silent ship — mirroring `src/flags/keys.ts` and
 * `src/lib/fateWireCodes.ts`.
 *
 * Tags are stored verbatim (the Turkish kind) on `post_summary.tags` as a CSV;
 * this module changes nothing about that wire/stored shape. The English aliases
 * (`show`/`discuss`/…) are normalization-only: a legacy seed value maps to its
 * Turkish kind for display, and each kind's CSS modifier is its English alias.
 */

/** The closed set of post-tag kinds, stored verbatim on `post_summary.tags`. */
export const POST_TAG_KINDS = ["göster", "tartışma", "soru", "söylenme", "meta"] as const;

/** A typed post-tag kind — the resolved, in-enum value (not untyped text). */
export type PostTagKind = (typeof POST_TAG_KINDS)[number];

/**
 * Each kind's CSS modifier class (`kp-tag--<cls>`) — the English alias doubling
 * as the styling key. Exhaustive over `PostTagKind`, so adding a kind without a
 * class is a compile error.
 */
export const POST_TAG_CLASS: Record<PostTagKind, string> = {
	göster: "show",
	tartışma: "discuss",
	soru: "ask",
	söylenme: "rant",
	meta: "meta",
};

/**
 * Legacy English aliases that may exist in seed data, mapped to their canonical
 * Turkish kind. The canonical kinds map to themselves so label resolution is one
 * lookup. Adding a kind without an alias row is a compile error.
 */
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

/** Whether a raw string is one of the five canonical (Turkish) kinds. */
export function isPostTagKind(kind: string): kind is PostTagKind {
	return ALLOWED.has(kind);
}

/**
 * Display label for a stored kind. Resolves a legacy English alias to its
 * Turkish kind; an unknown kind falls back to its raw value so it still renders.
 */
export function tagLabel(kind: string): string {
	return TAG_ALIASES[kind] ?? kind;
}

/**
 * CSS-modifier class for a stored kind (`göster` → `show`). Resolves legacy
 * aliases first; an unknown kind falls back to `meta` (the neutral styling).
 */
export function tagClass(kind: string): string {
	const resolved = TAG_ALIASES[kind];
	return resolved ? POST_TAG_CLASS[resolved] : "meta";
}
