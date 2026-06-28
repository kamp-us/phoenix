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
import {LIVE_RETRY_MAX_ATTEMPTS, nextLiveRetryDelayMs} from "./liveRetry";
import {useGlobalLivePin} from "./useGlobalLivePin";

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
	// subscribe effect; the budget + timer live here, the owner of both the client
	// (which reports the transient signal) and the pin (which retries).
	const [retryTick, setRetryTick] = useState(0);
	const attemptRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const scheduleRetry = useCallback(() => {
		const attempt = attemptRef.current;
		if (attempt >= LIVE_RETRY_MAX_ATTEMPTS) return;
		attemptRef.current = attempt + 1;
		if (timerRef.current != null) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(
			() => setRetryTick((tick) => tick + 1),
			nextLiveRetryDelayMs(attempt),
		);
	}, []);

	// A new session identity gets a fresh retry budget; cancel any pending timer on
	// re-key/unmount so a back-off never fires onto a torn-down client.
	useEffect(() => {
		attemptRef.current = 0;
		return () => {
			if (timerRef.current != null) clearTimeout(timerRef.current);
		};
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
