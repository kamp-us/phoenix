/**
 * Mounts one `FateClient` above the router, keyed on the better-auth user id.
 * Re-keying rebuilds the client (and its one normalized cache) on login/logout,
 * so a previous session's data never leaks into the next. The session cookie
 * authenticates each request; the user id here only scopes the cache.
 *
 * See `.patterns/fate-client-setup.md`.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {FateClient} from "react-fate";
import {useSession} from "../auth/client";
import {createClient} from "./client";
import {createLiveRetryController, type LiveRetryController} from "./liveRetry";
import {getPublicFateClient} from "./publicClient";
import {useGlobalLivePin} from "./useGlobalLivePin";

/**
 * The PUBLIC tier of the two-tier fate provider (ADR 0167): mounts the eager,
 * always-anonymous public client ABOVE the session gate. Its subtree reads public
 * views (the /pano feed list) that need no settled session, so they paint in parallel
 * with `get-session`. The client never re-keys (always anon), so this commit never
 * triggers the #438 re-key remount the authed `FateProvider` below defers to avoid.
 */
export function PublicFateProvider({children}: {children: React.ReactNode}) {
	return <FateClient client={getPublicFateClient()}>{children}</FateClient>;
}

// Holds the app-lifetime live pin (#711) from inside the FateClient context,
// where `useFateClient` resolves. Renders nothing.
function GlobalLivePin({userId, retryTick}: {userId: string | null; retryTick: number}) {
	useGlobalLivePin(userId, retryTick);
	return null;
}

export function FateProvider({children}: {children: React.ReactNode}) {
	const session = useSession();
	const userId = session.data?.user.id ?? null;

	// ADR 0095 client half: on a cold-start LIVE_UNAVAILABLE/503 the pin re-attempts
	// the connect on a bounded exponential back-off. `retryTick` re-runs the pin's
	// subscribe effect; the budget + coalescing live in the controller (which counts
	// connect attempts, not the per-subscription error fan-out one cold connect
	// produces — see `createLiveRetryController`, #1738).
	const [retryTick, setRetryTick] = useState(0);
	const controllerRef = useRef<LiveRetryController | null>(null);
	if (controllerRef.current == null) controllerRef.current = createLiveRetryController();

	const scheduleRetry = useCallback(() => {
		controllerRef.current?.schedule(() => setRetryTick((tick) => tick + 1));
	}, []);

	// A new session identity gets a fresh retry budget; cancel any pending retry on
	// re-key/unmount so a back-off never fires onto a torn-down client.
	useEffect(() => {
		const controller = controllerRef.current;
		controller?.reset();
		return () => controller?.cancel();
	}, [userId]);

	// Live SSE only opens for an authenticated client — `/fate/live` 401s for an
	// anonymous viewer, so an anon client gets no-op live methods (no retry loop).
	const client = useMemo(
		() => createClient({authenticated: userId != null, onTransientLiveError: scheduleRetry}),
		[userId, scheduleRetry],
	);

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
			<GlobalLivePin userId={userId} retryTick={retryTick} />
			{children}
		</FateClient>
	);
}
