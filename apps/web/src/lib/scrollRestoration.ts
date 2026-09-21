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
 * kinds in, one of three intents out, nothing in between representable.
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
}

/**
 * How long a restore keeps re-applying its offset while the page grows back. The pano feed
 * paints its rows only once the fate read resolves, so the document is short for the first
 * frames after a back navigation and the browser clamps any restore toward the top.
 */
export const SCROLL_SETTLE_TIMEOUT_MS = 1_000;

export function scrollIntent({navigation, hash, saved}: ScrollIntentInput): ScrollIntent {
	// A replace is a correction of the entry the reader is already on — the post-auth
	// redirect, a `?sort=` rewrite — so it is not an arrival and owes the viewport nothing.
	if (navigation === "replace") return {kind: "none"};
	// A forward navigation is an arrival, so it never keeps the offset the reader left behind.
	// Where it names a fragment that fragment is the arrival point — the pano feed's own
	// `N yorum` link is `/pano/<id>#comments` — and where it names none, the top is.
	if (navigation === "push") {
		const id = hash.startsWith("#") ? hash.slice(1) : "";
		return id === "" ? {kind: "top"} : {kind: "anchor", id};
	}
	// POP with nothing saved is the first load of a tab (react-router's initial navigation
	// type), where the browser's own anchor handling is the better answer than a forced 0.
	// `saved === 0` is a real saved offset and stays distinct from the absence.
	return saved === undefined ? {kind: "none"} : {kind: "restore", top: saved};
}
