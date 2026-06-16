/**
 * Mounts one `FateClient` above the router, keyed on the better-auth user id.
 * Re-keying rebuilds the client (and its one normalized cache) on login/logout,
 * so a previous session's data never leaks into the next. The session cookie
 * authenticates each request; the user id here only scopes the cache.
 *
 * See `.patterns/fate-client-setup.md`.
 */
import {useMemo} from "react";
import {FateClient} from "react-fate";
import {useSession} from "../auth/client";
import {createClient} from "./client";

export function FateProvider({children}: {children: React.ReactNode}) {
	const session = useSession();
	const userId = session.data?.user.id ?? null;
	// Live SSE only opens for an authenticated client — `/fate/live` 401s for an
	// anonymous viewer, so an anon client gets no-op live methods (no retry loop).
	const client = useMemo(() => createClient({authenticated: userId != null}), [userId]);

	// `useSession` resolves async ({data:null, isPending:true} → user) with no
	// synchronous hydration. Committing the keyed client before it settles mounts
	// the subtree under "anon", then re-keys to the real id once the session lands —
	// remounting the whole router and wiping any controlled form mounted in the
	// window (#438). Defer the first commit until settled so the first (and only)
	// key is the resolved identity; the key still rebuilds the cache on a genuine
	// login/logout identity change.
	if (session.isPending) return null;

	return (
		<FateClient key={userId ?? "anon"} client={client}>
			{children}
		</FateClient>
	);
}
