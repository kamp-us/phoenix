/**
 * The ⌘K palette's result read (ADR 0186). It runs INSIDE the fate tree but OUTSIDE any
 * `<Screen>`: the palette's field must keep focus and its typed query across every
 * keystroke, and a suspending `useRequest` would tear the open dialog down on each new
 * query. So this drives the client imperatively, the way `useImperativeView` does for the
 * shell's own reads — over connection roots rather than a single view.
 */
import {useEffect, useMemo, useRef, useState} from "react";
import {type ViewRef, view} from "react-fate";
import type {Post, Term} from "../../../worker/features/fate/views";
import {
	type ImperativeViewClient,
	type ImperativeViewData,
	useFateClientWhenEnabled,
} from "../../fate/useImperativeView";
import {MIN_SEARCH_LENGTH} from "../../lib/searchTarget";

/** Palette rows carry only what a row paints — never the viewer scalars a card needs. */
const TermPaletteView = view<Term>()({
	id: true,
	slug: true,
	title: true,
	definitionCount: true,
});

const PostPaletteView = view<Post>()({
	id: true,
	slug: true,
	title: true,
	host: true,
	commentCount: true,
});

const TermConnectionView = {items: {node: TermPaletteView}} as const;
const PostConnectionView = {items: {node: PostPaletteView}} as const;

/** Each surface's share of the palette. Small on purpose: the results page owns depth. */
const PER_SURFACE = 5;
/** A keystroke is not a query: the palette waits out a typing burst before it reads. */
const DEBOUNCE_MS = 180;
/**
 * How long a first read may run before the palette admits it is searching. The loading status
 * REPLACES the list, so showing it for a read that answers quickly is a flash, not feedback.
 */
const SLOW_READ_MS = 300;

/**
 * The palette's own row shapes. The read maps fate's view data into these rather than handing
 * the view type onward: a row is what the palette paints and where selecting it goes, and
 * nothing above this seam should have to satisfy a normalization tag to name one.
 */
export interface SearchTermResult {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly definitionCount: number;
}

export interface SearchPostResult {
	readonly id: string;
	readonly slug: string | null;
	readonly title: string;
	readonly host: string | null;
	readonly commentCount: number;
}

export type SearchResults =
	| {readonly status: "idle"}
	| {readonly status: "loading"}
	| {readonly status: "error"}
	| {
			readonly status: "ok";
			readonly terms: readonly SearchTermResult[];
			readonly posts: readonly SearchPostResult[];
	  };

/** The sigils ADR 0186 fixes for this surface. `@` waits on a member-search root. */
export const SOZLUK_SIGIL = ":";
export const PANO_SIGIL = "#";

type ConnectionItems = ReadonlyArray<{node: ViewRef<any>}>;

/**
 * `readView` statically narrows only the normalization key; the selected scalars are present
 * at runtime but absent from the static type, so each node read crosses that gap with the one
 * derived cast `readImperativeView` already documents (ADR 0022).
 */
async function readNodes<D>(
	fate: ImperativeViewClient,
	paletteView: any,
	items: ConnectionItems,
): Promise<readonly D[]> {
	const snapshots = await Promise.all(items.map(({node}) => fate.readView(paletteView, node)));
	return snapshots.map((snapshot) => snapshot.data as D);
}

const toTerm = (data: ImperativeViewData<typeof TermPaletteView>): SearchTermResult => ({
	id: data.id,
	slug: data.slug,
	title: data.title,
	definitionCount: data.definitionCount,
});

const toPost = (data: ImperativeViewData<typeof PostPaletteView>): SearchPostResult => ({
	id: data.id,
	slug: data.slug,
	title: data.title,
	host: data.host,
	commentCount: data.commentCount,
});

/**
 * Reads the query's results for the palette, debounced and race-guarded. A scope sigil
 * narrows the read to the one root that answers it, so `:` never pays for a pano keyset.
 */
export function useSearchResults(query: string, scope: string | undefined): SearchResults {
	const term = query.trim();
	const enabled = term.length >= MIN_SEARCH_LENGTH;
	// A closed palette reads nothing, so it must not demand a client: the shell mounts this
	// above/outside a settled fate tree in tests and on the first frames, and demanding a
	// context there would break renders that never search (the #6760 demotion).
	const fate = useFateClientWhenEnabled(enabled);
	const [results, setResults] = useState<SearchResults>({status: "idle"});
	// Only the LATEST read may land: a slower earlier keystroke's answer is stale data.
	const readId = useRef(0);

	const roots = useMemo(
		() => ({
			terms: scope === undefined || scope === SOZLUK_SIGIL,
			posts: scope === undefined || scope === PANO_SIGIL,
		}),
		[scope],
	);

	useEffect(() => {
		const id = readId.current + 1;
		readId.current = id;
		if (!enabled || fate == null) {
			setResults({status: "idle"});
			return;
		}
		// The rows already on screen stay there until the new answer replaces them: blanking them
		// for every keystroke is what made the list flash. Only a palette with nothing to show yet
		// admits it is searching, and only once the read is slow enough to need saying.
		setResults((previous) => (previous.status === "ok" ? previous : {status: "idle"}));
		const slow = setTimeout(() => {
			if (readId.current !== id) return;
			setResults((previous) => (previous.status === "ok" ? previous : {status: "loading"}));
		}, DEBOUNCE_MS + SLOW_READ_MS);
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const args = {query: term, first: PER_SURFACE};
					const request = {
						...(roots.terms ? {searchTerms: {list: TermConnectionView, args}} : {}),
						...(roots.posts ? {searchPosts: {list: PostConnectionView, args}} : {}),
					};
					const result = (await fate.request(request)) as {
						searchTerms?: {items: ConnectionItems};
						searchPosts?: {items: ConnectionItems};
					};
					const terms = (
						await readNodes<ImperativeViewData<typeof TermPaletteView>>(
							fate,
							TermPaletteView,
							result.searchTerms?.items ?? [],
						)
					).map(toTerm);
					const posts = (
						await readNodes<ImperativeViewData<typeof PostPaletteView>>(
							fate,
							PostPaletteView,
							result.searchPosts?.items ?? [],
						)
					).map(toPost);
					if (readId.current !== id) return;
					setResults({status: "ok", terms, posts});
				} catch (err) {
					console.error("[useSearchResults]", err);
					if (readId.current !== id) return;
					setResults({status: "error"});
				}
			})();
		}, DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			clearTimeout(slow);
		};
	}, [fate, term, enabled, roots]);

	return results;
}
