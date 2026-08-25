/**
 * The profile page's own read in ONE place (#7036) — the `profile` query root, its
 * page size, and the connection view the contributions list renders through. The
 * mounted read and the post-promote refetch share these, so the re-driven request can
 * only land on exactly the cache keys the rendered page holds.
 */
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
