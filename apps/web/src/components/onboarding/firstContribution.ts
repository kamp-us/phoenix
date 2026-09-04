/**
 * The welcome moment's exit ask (#7044, epic #4304): which first contribution to
 * suggest, to whom, and whether it still stands — decided DOM-free, the
 * `welcomeGating` idiom.
 *
 * Capability-aware by construction: who gets the ask is read off the declared floors in
 * `kunye/authorshipFloors.ts`, the same declaration `Authorship.ts`'s `AddEntry` /
 * `OpenTerm` instances take their `min` from. A reader who already clears `OpenTerm`'s
 * floor is past a first contribution, so the ask is not theirs — that, not a `"yazar"`
 * literal, is why a yazar never sees it, and it stays right if the ladder moves.
 *
 * Opening a başlık is never suggested: it is `OpenTerm`'s right, floored above the
 * reader this ask addresses, so both branches point at adding an entry.
 */
import {
	type AuthorshipRight,
	holdsAuthorshipRight,
} from "../../../worker/features/kunye/authorshipFloors";
import type {Tier} from "../../../worker/features/kunye/standing";
import {safeReturnTo} from "../../lib/returnTo";
import {type MarkerStorage, markerStorage, perUserMarker} from "./perUserMarker";

/** The right the ask exercises. */
export const NUDGE_RIGHT: AuthorshipRight = "kunye/AddEntry";

/** Holding this right means the reader is past their first contribution. */
export const SETTLED_RIGHT: AuthorshipRight = "kunye/OpenTerm";

const SOZLUK_ROOT = "/sozluk";

export type FirstContributionNudge =
	/** The arrival named a başlık — add the entry right there. */
	| {readonly kind: "add-entry"; readonly to: string; readonly term: string}
	/** The cold fallback: find a başlık in sözlük and add the first entry. */
	| {readonly kind: "browse-sozluk"; readonly to: string};

/**
 * The başlık an arrival points at, if any. Sözlük entries live on their başlık's own
 * page, so a başlık context and an entry context resolve to the same `/sozluk/<slug>`.
 */
export function sozlukTermContext(returnTo: string): {to: string; term: string} | null {
	const [path = ""] = safeReturnTo(returnTo).split(/[?#]/, 1);
	if (!path.startsWith(`${SOZLUK_ROOT}/`)) return null;
	const [slug = ""] = path.slice(SOZLUK_ROOT.length + 1).split("/", 1);
	if (!slug) return null;
	// `slug.replace(/-/g, " ")` is `SozlukTermPage`'s own slug-to-title rendering.
	return {to: `${SOZLUK_ROOT}/${slug}`, term: decodeSlug(slug).replace(/-/g, " ")};
}

function decodeSlug(slug: string): string {
	try {
		return decodeURIComponent(slug);
	} catch {
		return slug;
	}
}

export interface FirstContributionInput {
	readonly tier: Tier | null | undefined;
	readonly returnTo: string;
	readonly dismissed: boolean;
}

export function firstContributionNudge(
	input: FirstContributionInput,
): FirstContributionNudge | null {
	const {tier} = input;
	if (input.dismissed || !tier) return null;
	if (!holdsAuthorshipRight(tier, NUDGE_RIGHT)) return null;
	if (holdsAuthorshipRight(tier, SETTLED_RIGHT)) return null;
	const context = sozlukTermContext(input.returnTo);
	return context ? {kind: "add-entry", ...context} : {kind: "browse-sozluk", to: SOZLUK_ROOT};
}

/** Bumped to force every persisted dismissal stale. */
export const FIRST_CONTRIBUTION_SCHEMA = "v1";

const dismissal = perUserMarker("first-contribution-dismissed", FIRST_CONTRIBUTION_SCHEMA);

export const firstContributionDismissKey = dismissal.key;
export const isFirstContributionDismissed = dismissal.isSet;
export const dismissFirstContribution = dismissal.set;
export const firstContributionStorage: () => MarkerStorage | null = markerStorage;
