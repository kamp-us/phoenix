/**
 * One always-on live subscription held for the whole authenticated session, so the
 * shared SSE connection's refcount is never 0 while the app is mounted. See
 * `.patterns/fate-live-consistency.md#global-pin`.
 *
 * It must never fire for an anonymous client (an anon `EventSource` 401-loops): the
 * caller gates it on a non-null `userId`.
 */
import {useEffect} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";

const PinView = view<User>()({id: true});

// `retryTick` is an effect dep on purpose: each bump tears down the failed
// subscription and re-subscribes, which retries the whole EventSource connect
// because the pin is the only operation (ADR 0095). Back-off scheduling lives in
// `FateProvider`.
export function useGlobalLivePin(userId: string | null, retryTick = 0): void {
	const client = useFateClient();

	useEffect(() => {
		if (userId == null) return;
		const ref = client.ref("User", userId, PinView);
		return client.subscribeLiveView(PinView, ref);
	}, [client, userId, retryTick]);
}
