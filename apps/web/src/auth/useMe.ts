/**
 * Hook around the `me` query — served through **fate**.
 *
 * Pasaport's session contains the user id/email/name/image but the `username`
 * additional field doesn't always round-trip through Better Auth's session
 * inference reliably right after a setUsername write — so we read the canonical
 * row through the worker's own Pasaport (`me`) over `/fate`. Refetches when the
 * auth client's session updates.
 *
 * This is an **imperative** read (`client.request` + `client.readView`), not the
 * suspending `useRequest`: `useMe` runs in the `Layout` shell, above any
 * `<Screen>` Suspense boundary, and must NOT query `me` while unauthenticated
 * (the fate `me` resolver throws `UNAUTHORIZED` for anonymous viewers — see
 * `progress/task_4.md`'s accepted divergence). The `!session.data`
 * short-circuit preserves that: anonymous viewers never hit the wire.
 */
import {useCallback, useEffect, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/fate/views";
import {useSession} from "./client";

export interface MeUser {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

/** The `me` selection — the same five fields the GraphQL `Me` query read. */
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
		// Preserve the unauthenticated short-circuit: the fate `me` resolver throws
		// `UNAUTHORIZED` for anonymous viewers (task 4), so never query while
		// signed out — just clear the canonical row.
		if (!session.data) {
			setMe(null);
			return;
		}
		setLoading(true);
		try {
			const {me: ref} = await fate.request({me: {view: MeView}});
			const snapshot = ref ? await fate.readView(MeView, ref) : null;
			// `readView`'s snapshot `data` only statically narrows `id` (the
			// imperative path doesn't infer the field selection the way `useView`
			// does); the selected scalars are present at runtime, so read them
			// through the known `MeUser` shape at this imperative seam.
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
