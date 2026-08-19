/**
 * Shared pano subnav + routing vocabulary. Every feed — the sort subfeeds AND
 * kaydedilenler — is one `PanoFeed` variant behind `?sort=`, rather than a bespoke
 * saved page (#2196; in #1641 the saved surface dropped the nav row and stranded
 * the viewer).
 *
 * `saved` is deliberately NOT a `PostSort`: it is a reserved sentinel for a
 * per-viewer collection with its own data source, and never reaches the feed's
 * `sort` arg.
 */
import {DEFAULT_POST_SORT, type PostSort} from "./panoFeedSort";

export const PANO_SORT_PARAM = "sort";

export const SAVED_PANO_SORT = "saved";

export const SAVED_PANO_FILTER_ID = "kaydedilenler";

/**
 * Read by BOTH the feed request and the loading skeleton's row count, so the skeleton
 * reserves the height the arriving page occupies. A skeleton that under-counts the
 * payload is what jumped the footer ~941px on arrival (#2161).
 */
export const PANO_FEED_PAGE_SIZE = 20;

export interface PanoFilter {
	id: string;
	label: string;
	sort: PostSort;
}

export const PANO_FILTERS: PanoFilter[] = [
	{id: "sicak", label: "sıcak", sort: "hot"},
	{id: "yeni", label: "yeni", sort: "new"},
	{id: "en-iyi", label: "en iyi", sort: "top"},
	{id: "tartisma", label: "tartışma", sort: "discuss"},
];

export const DEFAULT_PANO_FILTER_ID = "sicak";

export type PanoVariant = {kind: "sort"; filterId: string; sort: PostSort} | {kind: "saved"};

export function panoVariantFromParam(param: string | null): PanoVariant {
	if (param === SAVED_PANO_SORT) return {kind: "saved"};
	const filter = PANO_FILTERS.find((f) => f.sort === param);
	return filter
		? {kind: "sort", filterId: filter.id, sort: filter.sort}
		: {kind: "sort", filterId: DEFAULT_PANO_FILTER_ID, sort: DEFAULT_POST_SORT};
}

export function panoActiveFilterId(variant: PanoVariant): string {
	return variant.kind === "saved" ? SAVED_PANO_FILTER_ID : variant.filterId;
}

export function panoSortFromFilterId(id: string): PostSort {
	return PANO_FILTERS.find((f) => f.id === id)?.sort ?? DEFAULT_POST_SORT;
}

export function panoSortParamFromFilterId(id: string): string {
	return id === SAVED_PANO_FILTER_ID ? SAVED_PANO_SORT : panoSortFromFilterId(id);
}

export const SAVED_HREF = `/pano?${PANO_SORT_PARAM}=${SAVED_PANO_SORT}`;
