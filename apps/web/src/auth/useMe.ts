/**
 * Reads the canonical `me` row over `/fate` and refetches when the session
 * updates. Reads the worker's own row (not the better-auth session) because the
 * `username` additional field doesn't reliably round-trip through Better Auth's
 * session inference right after a setUsername write.
 *
 * Imperative (`request` + `readView` via `useImperativeView`), not the suspending
 * `useRequest`: this runs in the `Layout` shell above any `<Screen>` Suspense
 * boundary, and must NOT query while unauthenticated — fate's `me` throws
 * `UNAUTHORIZED` for anonymous viewers, so the `enabled: !!session.data` gate
 * keeps them off the wire.
 *
 * Returns a discriminated `idle | loading | ok | error` `status` so a failed
 * fetch is distinguishable from a signed-out / not-yet-loaded `me` — both are
 * `null`, but only one is an error (#448). `loading` is retained as a derived
 * convenience for existing consumers, and `me` persists across a `loading`
 * refetch (cleared only on signed-out/error) so a session-update re-read doesn't
 * flash the header to a logged-out state.
 */
import {useRef} from "react";
import {view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {useImperativeView} from "../fate/useImperativeView";
import {readBootUser} from "../flags/boot";
import type {BootUser} from "../flags/shell-keys";
import {useSession} from "./client";

/**
 * The `me` shape — the client identity, single-sourced as {@link BootUser} (the wire `User`
 * minus fate's `__typename`, ADR 0185) so the async `me` read and the synchronous `__BOOT__.user`
 * seed carry the EXACT same fields. `tier` and `isModerator` are trusted account-level signals
 * read server-side (the stored column via `Kunye.tierOf` / the `moderates` relation), never
 * inferred from the session. `emailFailing` is the SELF failing-delivery signal (#2693) the
 * membrane notice reads via the `emailFailing?` seam — a non-self read is treated as deliverable.
 */
export type MeUser = BootUser;

export type MeStatus = "idle" | "loading" | "ok" | "error";

const MeView = view<User>()({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
	tier: true,
	isModerator: true,
	emailFailing: true,
});

export function useMe(): {
	me: MeUser | null;
	status: MeStatus;
	loading: boolean;
	refetch: () => Promise<void>;
} {
	const session = useSession();
	const {state, refetch} = useImperativeView("me", MeView, {
		enabled: !!session.data,
		// Refetch on every session identity change (e.g. after a setUsername write),
		// not just on a signed-in/out flip.
		deps: [session.data],
	});

	// Seed first paint from the edge-resolved `__BOOT__.user` (ADR 0185): the identity renders
	// synchronously so the signed-in surfaces never swap in content while the async `me` read
	// settles. The fate read reconciles on session change; absent `__BOOT__` ⇒ null ⇒ today's
	// async-only behavior. `me` persists across a `loading` refetch and while the session is still
	// settling (so the seed survives first paint), cleared only on a read error OR a definitively
	// signed-out session — never a flash to null.
	const meRef = useRef<MeUser | null>(readBootUser());
	if (state.status === "ok") {
		meRef.current = state.data;
	} else if (state.status === "error" || (!session.isPending && !session.data)) {
		meRef.current = null;
	}

	return {me: meRef.current, status: state.status, loading: state.status === "loading", refetch};
}
