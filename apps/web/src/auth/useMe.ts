/**
 * Reads the canonical `me` row over `/fate` and refetches when the session
 * updates. Reads the worker's own row (not the better-auth session) because the
 * `username` additional field doesn't reliably round-trip through Better Auth's
 * session inference right after a setUsername write.
 *
 * Imperative (`request` + `readView`), not the suspending `useRequest`: this
 * runs in the `Layout` shell above any `<Screen>` Suspense boundary, and must
 * NOT query while unauthenticated — fate's `me` throws `UNAUTHORIZED` for
 * anonymous viewers, so the `!session.data` short-circuit keeps them off the wire.
 */
import {useCallback, useEffect, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {useSession} from "./client";

export interface MeUser {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

const MeView = view<User>()({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
});

export function useMe(): {
	me: MeUser | null;
	loading: boolean;
	refetch: () => Promise<void>;
} {
	const session = useSession();
	const fate = useFateClient();
	const [me, setMe] = useState<MeUser | null>(null);
	const [loading, setLoading] = useState(false);

	const refetch = useCallback(async () => {
		// fate `me` throws `UNAUTHORIZED` for anonymous viewers — never query while signed out.
		if (!session.data) {
			setMe(null);
			return;
		}
		setLoading(true);
		try {
			const {me: ref} = await fate.request({me: {view: MeView}});
			const snapshot = ref ? await fate.readView(MeView, ref) : null;
			// `readView` only statically narrows `id`; the selected scalars are
			// present at runtime, so we read through the known `MeUser` shape.
			const user = (snapshot?.data ?? null) as MeUser | null;
			setMe(
				user
					? {
							id: user.id,
							email: user.email,
							name: user.name,
							image: user.image,
							username: user.username,
						}
					: null,
			);
		} catch (err) {
			console.error("[useMe]", err);
		} finally {
			setLoading(false);
		}
	}, [session.data, fate]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	return {me, loading, refetch};
}
