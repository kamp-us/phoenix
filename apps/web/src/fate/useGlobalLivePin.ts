/**
 * One always-on live subscription held for the whole authenticated session, so
 * the shared native SSE connection's refcount is NEVER 0 while the app is
 * mounted. This structurally eliminates the transient-0-refcount teardown race
 * (#711): fate's native live client closes the `EventSource` and drops its
 * random `connectionId` the instant `operations.size` reaches 0 (`remove()` runs
 * `if (operations.size === 0) { source.close(); nativeLiveClient = undefined }`),
 * and the next subscribe rebuilds a fresh stream with a new `connectionId`. A
 * write mutation makes the only entity view on the page transiently
 * unsubscribe+resubscribe during its in-flight refetch; with no other operation
 * the refcount hits 0, the stream closes, and the mutation's fire-and-forget
 * publish lands on the now-dead `connectionId` and is LOST. Holding one
 * operation for the session lifetime makes `operations.size === 0` unreachable
 * during that churn, so the EventSource + `connectionId` stay stable and every
 * publish reaches a live connection. See ADR 0091 + `.patterns/fate-live-views.md`.
 *
 * The anchor is the viewer's OWN `User` row, keyed on the better-auth session id
 * — always valid for an authenticated session (the `me` query resolves the same
 * id; `User.id === CurrentUser.id`) and the lightest possible: a single
 * entity-field subscription, no list/connection fan-out, no pagination churn. It
 * never fires for an anonymous client (an anon `EventSource` 401-loops): the
 * caller gates it on a non-null `userId`.
 */
import {useEffect} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";

const PinView = view<User>()({id: true});

// `retryTick` bumps on a cold-start LIVE_UNAVAILABLE/503 back-off (ADR 0095): it is
// in the effect deps, so each bump tears down the failed subscription and
// re-subscribes — fate's native client rebuilds the whole EventSource connect when
// the pin is the only operation, so a bump retries the entire connect on the next
// mount, exactly as ADR 0095 specifies. The back-off scheduling + bounded budget
// live in `FateProvider`, which owns both the client and this pin.
export function useGlobalLivePin(userId: string | null, retryTick = 0): void {
	const client = useFateClient();

	useEffect(() => {
		if (userId == null) return;
		const ref = client.ref("User", userId, PinView);
		return client.subscribeLiveView(PinView, ref);
	}, [client, userId, retryTick]);
}
