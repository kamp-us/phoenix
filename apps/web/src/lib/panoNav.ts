/**
 * Shared pano subnav vocabulary — the feed sort chips + the saved-posts link, so
 * the feed (`PanoFeed`) and the saved-posts page (`SavedPostsPage`) render the SAME
 * navigation instead of drifting apart (#1641: the saved page had dropped the whole
 * nav row to a bare title, stranding the viewer with no in-subnav route back to a
 * feed sort).
 *
 * The active feed sort is carried in a `?sort=` query param whose value is the
 * server `PostSort` (English, per the URL-routes-are-English convention), so a sort
 * is deep-linkable — the saved page's chips link back to `/pano?sort=<sort>` and the
 * feed seeds its initial chip from the param.
 */
import type {SubnavLink} from "../components/layout/Subnav";
import {DEFAULT_POST_SORT, type PostSort} from "./panoFeedSort";

/** The query param that carries the active feed sort (deep-linkable). */
export const PANO_SORT_PARAM = "sort";

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

/** Saved-posts (`/pano/kaydedilenler`) is per-viewer, so it's shown signed-in only. */
export const SAVED_LINK: SubnavLink = {to: "/pano/kaydedilenler", label: "kaydedilenler"};

/** The filter id for a raw `?sort=` value, defaulting when absent/unrecognized. */
export function panoFilterIdFromParam(param: string | null): string {
	return PANO_FILTERS.find((f) => f.sort === param)?.id ?? DEFAULT_PANO_FILTER_ID;
}

/**
 * The server `sort` a filter id selects — the inverse of `panoFilterIdFromParam`,
 * so an in-feed chip switch can write its sort back to the `?sort=` param and keep
 * the URL the source of truth. Defaults when the id is unrecognized.
 */
export function panoSortFromFilterId(id: string): PostSort {
	return PANO_FILTERS.find((f) => f.id === id)?.sort ?? DEFAULT_POST_SORT;
}

/** The feed URL for a given sort — the route a saved-page sort chip navigates back to. */
export function panoSortHref(sort: PostSort): string {
	return `/pano?${PANO_SORT_PARAM}=${sort}`;
}
