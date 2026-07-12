/**
 * `useAdminProbe` — the server-authoritative answer to "may THIS user open the admin
 * console?" (#2740, epic #2711), the client signal that decides whether to mount+fetch
 * the lazy console bundle. Modeled on `useDivanAccess`: it probes the `requireAdmin`-gated
 * `admin.probe` read and reports whether it resolved (granted) or denied (the invisible
 * `Denied`), so a non-admin is indistinguishable from not-signed-in and the console chunk
 * is only ever imported in the granted branch.
 *
 * Imperative (`useImperativeView`, not a suspending read), for the same reason as
 * `useMe`/`useDivanAccess`: the probe drives a route element that must resolve to a safe
 * default rather than suspend.
 *
 * Two guards keep it dark and fail-closed:
 *   - It only probes when the `phoenix-admin-console` flag is on AND the viewer is signed
 *     in. With the flag off the server read fails `Denied` for everyone anyway, but gating
 *     the wire on the flag keeps the console fully inert (no request) by default.
 *   - Any error (the `Denied` denial, or a transport failure) ⇒ not granted, and the
 *     returned `granted` ANDs the flag back in, so a stale grant can never outlive the flag.
 */

import {view} from "react-fate";
import type {AdminProbe} from "../../worker/features/admin-console/probe-view";
import {useSession} from "../auth/client";
import {useImperativeView} from "../fate/useImperativeView";
import {PHOENIX_ADMIN_CONSOLE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";

const AdminProbeView = view<AdminProbe>()({id: true, admin: true});

export interface AdminAccess {
	/** `true` iff the server probe resolved AND the flag is on — the mount-the-console gate. */
	readonly granted: boolean;
	/** `true` while the probe is in flight (access not yet decided) — render nothing, don't 404-flash. */
	readonly loading: boolean;
}

export function useAdminProbe(): AdminAccess {
	const {value: flagOn} = useFlag(PHOENIX_ADMIN_CONSOLE, false);
	const session = useSession();
	const signedIn = !!session.data;
	const {state} = useImperativeView("admin.probe", AdminProbeView, {
		enabled: flagOn && signedIn,
		deps: [signedIn],
	});
	// AND the flag back in so a grant can never outlive the flag flipping off.
	const granted = flagOn && state.status === "ok" && !!state.data;
	return {granted, loading: state.status === "loading"};
}
