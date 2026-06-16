/**
 * Reads a user's profile counts (başlık/yorum/tanım) over `/fate` by username.
 * Consumes the same `profile` root + `Profile` view as `/u/:username`
 * (`UserProfilePage`), selecting only the count scalars — no `contributions`
 * connection, so the resolver skips its keyset query.
 *
 * Imperative (`request` + `readView`), not the suspending `useRequest`, for the
 * same reason as `useMe`: `ProfilePage` renders directly under the `Layout`
 * shell, above any `<Screen>` Suspense boundary, so it must drive fate itself
 * rather than suspend. A null/empty username (user not yet bootstrapped) short-
 * circuits off the wire and leaves the counts null.
 */
import {useCallback, useEffect, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {Profile} from "../../worker/features/fate/views";

export interface ProfileStats {
	postCount: number;
	commentCount: number;
	definitionCount: number;
}

const ProfileStatsView = view<Profile>()({
	userId: true,
	postCount: true,
	commentCount: true,
	definitionCount: true,
});

export function useProfileStats(username: string | null | undefined): ProfileStats | null {
	const fate = useFateClient();
	const [stats, setStats] = useState<ProfileStats | null>(null);

	const refetch = useCallback(async () => {
		if (!username) {
			setStats(null);
			return;
		}
		try {
			const {profile: ref} = await fate.request({
				profile: {view: ProfileStatsView, args: {username}},
			});
			const snapshot = ref ? await fate.readView(ProfileStatsView, ref) : null;
			// `readView` statically narrows only `userId`; the selected count
			// scalars are present at runtime, read through the known shape.
			const data = (snapshot?.data ?? null) as ProfileStats | null;
			setStats(
				data
					? {
							postCount: data.postCount,
							commentCount: data.commentCount,
							definitionCount: data.definitionCount,
						}
					: null,
			);
		} catch (err) {
			console.error("[useProfileStats]", err);
		}
	}, [username, fate]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	return stats;
}
