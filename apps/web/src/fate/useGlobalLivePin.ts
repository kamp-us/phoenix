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

export function useGlobalLivePin(userId: string | null): void {
	const client = useFateClient();

	useEffect(() => {
		if (userId == null) return;
		const ref = client.ref("User", userId, PinView);
		return client.subscribeLiveView(PinView, ref);
	}, [client, userId]);
}
