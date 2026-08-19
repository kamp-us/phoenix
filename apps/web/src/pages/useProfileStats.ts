/**
 * A user's profile counts by username. Imperative rather than the suspending
 * `useRequest` because `ProfilePage` renders above any `<Screen>` boundary and so
 * cannot suspend. The state is discriminated so a failed fetch stays distinguishable
 * from a genuine zero-activity user, which would otherwise render as a lying `0` (#448).
 */
import {useMemo} from "react";
import {view} from "react-fate";
import type {Profile} from "../../worker/features/fate/views";
import {useImperativeView} from "../fate/useImperativeView";

// A `Pick` over the codegen'd `Profile` entity, never a hand-restated interface.
export type ProfileStats = Pick<
	Profile,
	"postCount" | "commentCount" | "definitionCount" | "totalKarma"
>;

export type ProfileStatsState =
	| {status: "idle"}
	| {status: "loading"}
	| {status: "ok"; stats: ProfileStats}
	| {status: "error"};

const ProfileStatsView = view<Profile>()({
	userId: true,
	postCount: true,
	commentCount: true,
	definitionCount: true,
	totalKarma: true,
});

// A `null` snapshot is a successful zero result, NOT an error — it maps to all-zero
// counts, which is the honest answer for a brand-new user.
export function toProfileStatsState(data: ProfileStats | null): ProfileStatsState {
	return {
		status: "ok",
		stats: data
			? {
					postCount: data.postCount,
					commentCount: data.commentCount,
					definitionCount: data.definitionCount,
					totalKarma: data.totalKarma,
				}
			: {postCount: 0, commentCount: 0, definitionCount: 0, totalKarma: 0},
	};
}

export function useProfileStats(username: string | null | undefined): ProfileStatsState {
	// Memoize so the args object is a stable refetch dependency — a fresh object
	// each render would re-run the read every render.
	const args = useMemo(() => (username ? {username} : undefined), [username]);
	const {state} = useImperativeView("profile", ProfileStatsView, {
		args,
		enabled: !!username,
	});

	return state.status === "ok" ? toProfileStatsState(state.data) : state;
}
