/**
 * Where one navigation leaves the viewport.
 *
 * react-router's own `<ScrollRestoration />` is unreachable at this app's pin: in
 * `react-router@7.18.4` it renders `useScrollRestoration`, whose first line resolves
 * `useDataRouterContext("useScrollRestoration")` and throws through `invariant` when no
 * `DataRouterContext` is mounted (`dist/development/chunk-OB3PAWPO.mjs`). `BrowserRouter`
 * mounts none, so the element would crash the first render rather than restore anything —
 * which is why #9268 rules the data-router migration out and hand-rolls this instead.
 *
 * The decision is separated from the DOM so it can be read as a table: three navigation
 * kinds in, one of four intents out, nothing in between representable.
 */

/** react-router's `NavigationType`, narrowed to this module's own vocabulary. */
export type NavigationKind = "pop" | "push" | "replace";

/** What the viewport owes one navigation. */
export type ScrollIntent =
	| {readonly kind: "restore"; readonly top: number}
	| {readonly kind: "anchor"; readonly id: string}
	| {readonly kind: "top"}
	| {readonly kind: "none"};

export interface ScrollIntentInput {
	readonly navigation: NavigationKind;
	/** `location.hash`, the empty string when the URL carries none. */
	readonly hash: string;
	/** The offset saved for this history entry; `undefined` when none was ever saved. */
	readonly saved: number | undefined;
	/**
	 * Whether this is the session's very first navigation — the cold load, which react-router
	 * reports as a POP. Without it, that cold load and a back navigation to an entry the reader
	 * never scrolled are one indistinguishable "POP with nothing saved", and the reader lands on
	 * the feed carrying the post's offset (#9268).
	 */
	readonly isFirstNavigation: boolean;
}

/**
 * How long a restore keeps re-applying its offset while the page grows back. The pano feed
 * paints its rows only once the fate read resolves, so the document is short for the first
 * frames after a back navigation and the browser clamps any restore toward the top.
 */
export const SCROLL_SETTLE_TIMEOUT_MS = 1_000;

/**
 * Fragment families a page already scrolls for itself.
 *
 * `PanoPostDetail` runs `useCommentAnchor` over `#comment-<id>`: it waits for the node through a
 * `MutationObserver` — a comment mounts when its own view snapshot fulfills (#649) — and then
 * centres it. Two scroll authorities on one element is two resting positions, whichever lands
 * last, so this module claims no fragment a page owns. The arrival still lands at the top and the
 * page's own anchoring is what moves the reader from there.
 */
const PAGE_OWNED_FRAGMENT_PREFIXES = ["comment-"] as const;

function pageOwnsFragment(id: string): boolean {
	return PAGE_OWNED_FRAGMENT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Where an arrival at this URL rests, with no history behind it: the fragment it names, or the
 * top. The pano feed's own `N yorum` link is `/pano/<id>#comments`, so a hash arrival that kept
 * the departing offset would read as the previous page's scroll carried over. A fragment the
 * landing page scrolls itself is the top too — this module stands down rather than race it.
 */
function arrivalIntent(hash: string): ScrollIntent {
	const id = hash.startsWith("#") ? hash.slice(1) : "";
	if (id === "" || pageOwnsFragment(id)) return {kind: "top"};
	return {kind: "anchor", id};
}

export function scrollIntent({
	navigation,
	hash,
	saved,
	isFirstNavigation,
}: ScrollIntentInput): ScrollIntent {
	// A replace is a correction of the entry the reader is already on — the post-auth
	// redirect, a `?sort=` rewrite — so it is not an arrival and owes the viewport nothing.
	if (navigation === "replace") return {kind: "none"};
	if (navigation === "pop") {
		// `saved === 0` is a real saved offset and stays distinct from the absence.
		if (saved !== undefined) return {kind: "restore", top: saved};
		// The cold load is a POP too, and there the browser's own fragment handling is the better
		// answer than a forced 0 — this hook was not mounted when the entry was left.
		if (isFirstNavigation) return {kind: "none"};
		// Every other POP with nothing saved is an entry this hook did handle and the reader never
		// scrolled, so it rests where an arrival rests. Answering `none` here left the viewport on
		// the departing page's offset, which is the regression this issue exists to fix.
	}
	return arrivalIntent(hash);
}
