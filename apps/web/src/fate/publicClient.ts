/**
 * The eager, always-anonymous PUBLIC fate client — the top tier of the two-tier fate
 * provider (ADR 0167). It must stay `authenticated: false` forever: never re-keying is
 * what lets it commit pre-session without the #438 anon→id re-key remount.
 */
import {noteSnapshotHydrated} from "../lib/feedPerf";
import {createClient, type FateClientInstance} from "./client";
import {hydrateAnonPublicClient, installAnonSnapshotPersistence} from "./snapshot";

let publicClient: FateClientInstance | null = null;

// A module singleton, not a per-render `useMemo`: the tier is torn out of the tree once
// the session settles, and the cache has to survive that.
export function getPublicFateClient(): FateClientInstance {
	if (publicClient == null) {
		publicClient = createClient({authenticated: false});
		// Hydrate here, at creation — fate's hydrate-before-render contract. The
		// uninstaller is discarded on purpose: the singleton never tears down.
		if (hydrateAnonPublicClient(publicClient)) noteSnapshotHydrated();
		installAnonSnapshotPersistence(publicClient);
	}
	return publicClient;
}
