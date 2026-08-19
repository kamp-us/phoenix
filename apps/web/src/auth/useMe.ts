/**
 * Reads the canonical `me` row over `/fate`. Imperative, not the suspending
 * `useRequest`: this runs in the `Layout` shell above any `<Screen>` Suspense
 * boundary, and must NOT query while unauthenticated — fate's `me` throws
 * `UNAUTHORIZED` for anonymous viewers, so the `enabled: !!session.data` gate
 * keeps them off the wire.
 */
import {useRef} from "react";
import {view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {useImperativeView} from "../fate/useImperativeView";
import {readBootUser} from "../flags/boot";
import type {BootUser} from "../flags/shell-keys";
import {useSession} from "./client";

/** Single-sourced as {@link BootUser} so the async read and the `__BOOT__.user` seed match — see ADR 0185. */
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
		deps: [session.data],
	});

	// Seed first paint from `__BOOT__.user` (ADR 0185). `me` is cleared only on a read error or a
	// definitively signed-out session — it must survive a `loading` refetch, or the header flashes
	// logged-out mid-session.
	const meRef = useRef<MeUser | null>(readBootUser());
	if (state.status === "ok") {
		meRef.current = state.data;
	} else if (state.status === "error" || (!session.isPending && !session.data)) {
		meRef.current = null;
	}

	return {me: meRef.current, status: state.status, loading: state.status === "loading", refetch};
}
