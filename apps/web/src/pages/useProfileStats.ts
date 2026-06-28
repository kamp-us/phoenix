/**
 * Reads a user's profile counts (başlık/yorum/tanım) over `/fate` by username.
 * Consumes the same `profile` root + `Profile` view as `/u/:username`
 * (`UserProfilePage`), selecting only the count scalars — no `contributions`
 * connection, so the resolver skips its keyset query.
 *
 * Imperative (`request` + `readView` via `useImperativeView`), not the suspending
 * `useRequest`, for the same reason as `useMe`: `ProfilePage` renders directly
 * under the `Layout` shell, above any `<Screen>` Suspense boundary, so it must
 * drive fate itself rather than suspend. A null/empty username (user not yet
 * bootstrapped) leaves `enabled` false, so the read short-circuits off the wire
 * and the state stays idle.
 *
 * Returns a discriminated `idle | loading | ok | error` state so a failed fetch
 * is distinguishable from a genuine zero-activity user — the consumer renders an
 * honest error instead of a misleading `0` (#448), mirroring the `SozlukHome`
 * `loading | ok | error` status convention.
 */
import {useMemo} from "react";
import {view} from "react-fate";
import type {Profile} from "../../worker/features/fate/views";
import {useImperativeView} from "../fate/useImperativeView";

/**
 * The projected count shape, derived from the codegen'd `Profile` Entity (ADR
 * 0022) — a `Pick` over the four count scalars, never a hand-restated interface.
 * `totalKarma` is `user_profile.total_karma` (ADR 0050), surfaced ambiently on the
 * owner's profile (#1208). The selected `userId` normalization key is dropped here
 * by projection — `toProfileStatsState` performs that narrowing.
 */
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

/**
 * Pure snapshot → `ok` mapping, factored out so the count-projection contract is
 * unit-testable without a DOM/React runtime — the swallow this fixes lived in
 * exactly this un-asserted path. A `null` snapshot (user not found / empty view)
 * is a real, successful zero result, NOT an error: it maps to all-zero counts
 * (and zero karma — an honest çaylak, never a placeholder; #1208 AC).
 */
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
