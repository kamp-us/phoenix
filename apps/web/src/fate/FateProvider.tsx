/**
 * The fate provider — mounts one `FateClient` in the tree, keyed on user id.
 *
 * The client holds one normalized cache. Re-keying the provider on the
 * better-auth user id rebuilds the client (and its cache) on login/logout, so a
 * previous session's data never leaks into the next. A fresh client is built
 * per key via `useMemo`, and the `key` on the provider forces a remount when the
 * identity changes.
 *
 * Lives above the router so any screen can read through fate. The session cookie
 * (read by `createClient`'s `credentials: "include"` fetch) is what actually
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
	const client = useMemo(() => createClient(), [userId]);

	return (
		<FateClient key={userId ?? "anon"} client={client}>
			{children}
		</FateClient>
	);
}
