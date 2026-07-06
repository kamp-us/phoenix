/**
 * Shared pano subnav + routing vocabulary. Every pano feed — the sort subfeeds
 * (sıcak / yeni / en iyi / tartışma) AND kaydedilenler — is one `PanoFeed`
 * variant selected by the deep-linkable `?sort=` param, so there's one feed
 * shape and one routing model rather than a bespoke saved page (#2196; #1641: the
 * saved surface once dropped the whole nav row, stranding the viewer).
 *
 * The `?sort=` value is the server `PostSort` (English, per URL-routes-are-English)
 * for a sort subfeed, plus one reserved sentinel `saved` for kaydedilenler — a
 * per-viewer collection with a distinct data source (`savedPosts`), not a `posts`
 * sort. `saved` is deliberately NOT a `PostSort`: it never reaches the feed's
 * `sort` arg, it selects the saved variant instead.
 */
import {DEFAULT_POST_SORT, type PostSort} from "./panoFeedSort";

/** The query param that carries the active feed variant (deep-linkable). */
export const PANO_SORT_PARAM = "sort";

/** The reserved `?sort=` sentinel for the kaydedilenler variant — not a `PostSort`. */
export const SAVED_PANO_SORT = "saved";

/** The subnav filter id for the kaydedilenler variant. */
export const SAVED_PANO_FILTER_ID = "kaydedilenler";

/**
 * The feed's first-page size — the single source both the feed request
 * (`PanoFeed`'s `first: PANO_FEED_PAGE_SIZE`) and the loading skeleton
 * (`PanoFeedSkeleton`'s row count) read, so the skeleton reserves the SAME height
 * the arriving page occupies. A skeleton row count that under-counts the payload is
 * the height-mismatch that jumps the footer ~941px on arrival (#2161); sourcing both
 * from here makes that drift unrepresentable.
 */
export const PANO_FEED_PAGE_SIZE = 20;

export interface PanoFilter {
	id: string;
	label: string;
	sort: PostSort;
}

/** UI sort labels (Turkish) → server `sort` (the shared `PostSort` vocabulary). */
export const PANO_FILTERS: PanoFilter[] = [
	{id: "sicak", label: "sıcak", sort: "hot"},
	{id: "yeni", label: "yeni", sort: "new"},
	{id: "en-iyi", label: "en iyi", sort: "top"},
	{id: "tartisma", label: "tartışma", sort: "discuss"},
];

/** The chip shown when no (or an unrecognized) `?sort=` is present. */
export const DEFAULT_PANO_FILTER_ID = "sicak";

/**
 * The active `PanoFeed` variant, resolved from the `?sort=` param: a `sort` subfeed
 * carrying its server `PostSort`, or the per-viewer `saved` collection. Modeling this
 * as a discriminated variant (not a bare filter id) is what lets one feed component
 * branch on the data source while sharing the routing model.
 */
export type PanoVariant = {kind: "sort"; filterId: string; sort: PostSort} | {kind: "saved"};

/**
 * Resolve the `?sort=` param to the active variant. The reserved `saved` sentinel
 * selects the kaydedilenler variant; any other value maps to a sort subfeed
 * (defaulting when absent/unrecognized).
 */
export function panoVariantFromParam(param: string | null): PanoVariant {
	if (param === SAVED_PANO_SORT) return {kind: "saved"};
	const filter = PANO_FILTERS.find((f) => f.sort === param);
	return filter
		? {kind: "sort", filterId: filter.id, sort: filter.sort}
		: {kind: "sort", filterId: DEFAULT_PANO_FILTER_ID, sort: DEFAULT_POST_SORT};
}

/** The active subnav filter id for a variant — the sort chip, or the saved chip. */
export function panoActiveFilterId(variant: PanoVariant): string {
	return variant.kind === "saved" ? SAVED_PANO_FILTER_ID : variant.filterId;
}

/**
 * The server `sort` a filter id selects, so a chip switch can write its sort back
 * to the `?sort=` param and keep the URL the source of truth. Defaults when the id
 * is unrecognized.
 */
export function panoSortFromFilterId(id: string): PostSort {
	return PANO_FILTERS.find((f) => f.id === id)?.sort ?? DEFAULT_POST_SORT;
}

/**
 * The `?sort=` value a subnav filter id writes to the URL — a server `PostSort` for
 * a sort chip, the `saved` sentinel for the kaydedilenler chip. One inverse of the
 * param resolution so every chip (including saved) drives the same routing model.
 */
export function panoSortParamFromFilterId(id: string): string {
	return id === SAVED_PANO_FILTER_ID ? SAVED_PANO_SORT : panoSortFromFilterId(id);
}

/** The canonical kaydedilenler URL — the saved variant of the shared feed. */
export const SAVED_HREF = `/pano?${PANO_SORT_PARAM}=${SAVED_PANO_SORT}`;
