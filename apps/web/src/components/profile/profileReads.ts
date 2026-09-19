/**
 * The profile page's own read in ONE place (#7036) — the `profile` query root, its
 * page size, and the connection view the contributions list renders through. The
 * mounted read and the post-promote refetch share these, so the re-driven request can
 * only land on exactly the cache keys the rendered page holds.
 */
import type {RequestOptions} from "@nkzw/fate";
import {view} from "react-fate";
import type {Profile} from "../../../worker/features/fate/views";
import {ContributionView} from "./ContributionRow";
import {UserProfileHeaderView} from "./UserProfileHeader";

export const PROFILE_PAGE_SIZE = 20;

export const ContributionsConnectionView = {items: {node: ContributionView}} as const;

export const UserProfileView = view<Profile>()({
	...UserProfileHeaderView,
	contributions: ContributionsConnectionView,
});

export const profileRequest = (username: string) => ({
	profile: {view: UserProfileView, args: {username, contributions: {first: PROFILE_PAGE_SIZE}}},
});

/**
 * Not fate's `cache-first` default (#9265): the profile counters are re-counted per
 * request on the server, nothing fans a `Profile` invalidation, and the normalized cache
 * is persisted to `localStorage` — so a cache-first read paints last session's counts and
 * never corrects them. `stale-while-revalidate` is the hydrated-cache composition
 * `.patterns/fate-hydration.md` prescribes: paint from the cache, patch from the network,
 * and the rendered `useView` subscriptions pick the patch up.
 */
export const PROFILE_READ_OPTIONS: RequestOptions = {mode: "stale-while-revalidate"};
