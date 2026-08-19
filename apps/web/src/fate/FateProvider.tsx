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
import {noteSnapshotHydrated} from "../lib/feedPerf";
import {createClient} from "./client";
import {createLiveRetryController, type LiveRetryController} from "./liveRetry";
import {getPublicFateClient} from "./publicClient";
import {
	hydrateAuthedClient,
	installAuthedSnapshotPersistence,
	teardownAuthedSnapshot,
} from "./snapshot";
import {useGlobalLivePin} from "./useGlobalLivePin";

/** The PUBLIC tier of the two-tier fate provider, mounted ABOVE the session gate
 *  (ADR 0167). */
export function PublicFateProvider({children}: {children: React.ReactNode}) {
	return <FateClient client={getPublicFateClient()}>{children}</FateClient>;
}

// Exists only to hold the app-lifetime live pin (#711) from inside the FateClient
// context, where `useFateClient` resolves.
function GlobalLivePin({userId, retryTick}: {userId: string | null; retryTick: number}) {
	useGlobalLivePin(userId, retryTick);
	return null;
}

export function FateProvider({children}: {children: React.ReactNode}) {
	const session = useSession();
	const userId = session.data?.user.id ?? null;

	// `retryTick` re-runs the pin's subscribe effect; the budget lives in the controller
	// (ADR 0095, `createLiveRetryController`).
	const [retryTick, setRetryTick] = useState(0);
	const controllerRef = useRef<LiveRetryController | null>(null);
	if (controllerRef.current == null) controllerRef.current = createLiveRetryController();

	const scheduleRetry = useCallback(() => {
		controllerRef.current?.schedule(() => setRetryTick((tick) => tick + 1));
	}, []);

	// Cancel on re-key/unmount so a back-off never fires onto a torn-down client.
	useEffect(() => {
		const controller = controllerRef.current;
		controller?.reset();
		return () => controller?.cancel();
	}, [userId]);

	// Without this the budget is terminal once its ~7.75s span is spent, leaving the tab
	// silently non-live until reload (#3790). `rearm` no-ops unless the budget is spent,
	// so firing it on every visibility flip is cheap.
	useEffect(() => {
		if (userId == null) return;
		const rearm = () => controllerRef.current?.rearm(() => setRetryTick((tick) => tick + 1));
		const onVisible = () => {
			if (document.visibilityState === "visible") rearm();
		};
		window.addEventListener("online", rearm);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			window.removeEventListener("online", rearm);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [userId]);

	// Drop the PREVIOUS identity's persisted snapshot on any identity change (A→B, or
	// sign-out A→anon), so its private myVote/isSaved overlay never outlives it (#2321).
	const prevUserIdRef = useRef<string | null>(null);
	useEffect(() => {
		const prev = prevUserIdRef.current;
		if (prev != null && prev !== userId) teardownAuthedSnapshot(prev);
		prevUserIdRef.current = userId;
	}, [userId]);

	// Live SSE only opens for an authenticated client — `/fate/live` 401s for an
	// anonymous viewer, so an anon client gets no-op live methods (no retry loop).
	const client = useMemo(() => {
		const created = createClient({
			authenticated: userId != null,
			onTransientLiveError: scheduleRetry,
		});
		// Hydrate here, at client creation — BEFORE any `useRequest` renders under the
		// FateClient below (fate's hydrate-before-render contract).
		if (userId != null && hydrateAuthedClient(created, userId)) noteSnapshotHydrated();
		return created;
	}, [userId, scheduleRetry]);

	// Keyed on the client instance, not just `userId`, so a re-key uninstalls the old
	// client's listeners before the next installs (#2321).
	useEffect(() => {
		if (userId == null) return;
		return installAuthedSnapshotPersistence(client, userId);
	}, [client, userId]);

	// Deliberate blank first paint: committing before the session settles mounts the
	// subtree under "anon" and then re-keys to the real id, remounting the whole router
	// and wiping any controlled form open in that window (#438).
	if (session.isPending) return null;

	return (
		<FateClient key={userId ?? "anon"} client={client}>
			<GlobalLivePin userId={userId} retryTick={retryTick} />
			{children}
		</FateClient>
	);
}
