/**
 * The eager, always-anonymous PUBLIC fate client — the top tier of the two-tier fate
 * provider (ADR 0167). One app-lifetime instance mounted ABOVE the session gate so
 * anon-capable public read views (the /pano feed list) can paint in parallel with
 * `/api/auth/get-session` instead of serialized behind it.
 *
 * It is a distinct, never-re-keyed instance (always `authenticated: false`), which is
 * exactly why it can commit pre-session without reintroducing the #438 anon→id re-key
 * remount that the identity-keyed authed client below the gate defers to avoid: this
 * client never becomes authenticated, so it never re-keys. Live SSE is no-op here
 * (an anon `/fate/live` `EventSource` 401-loops); live + mutations + viewer-scoped
 * scalars stay on the authed client below the gate. See ADR 0167.
 */
import {createClient, type FateClientInstance} from "./client";

let publicClient: FateClientInstance | null = null;

// A module singleton, not a per-render `useMemo`: the client owns one normalized cache,
// and a lazily-cached single instance keeps that cache stable across every mount/unmount
// of the eager public tier (it is torn out of the tree once the session settles and the
// authed feed takes over, but the instance — and its warm cache — persists for the app
// lifetime).
export function getPublicFateClient(): FateClientInstance {
	if (publicClient == null) publicClient = createClient({authenticated: false});
	return publicClient;
}
