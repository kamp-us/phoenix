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
 * Fail-closed by construction: it only probes for a signed-in viewer (an anonymous visitor
 * never hits the wire), and any error — the `Denied` denial, or a transport failure —
 * reports not-granted. The grant is the SERVER's `requireAdmin` verdict and nothing else;
 * this hook cannot widen it.
 */

import {view} from "react-fate";
import type {AdminProbe} from "../../worker/features/admin-console/probe-view";
import {useSession} from "../auth/client";
import {useImperativeView} from "../fate/useImperativeView";

const AdminProbeView = view<AdminProbe>()({id: true, admin: true});

export interface AdminAccess {
	/** `true` iff the server probe resolved — the mount-the-console gate. */
	readonly granted: boolean;
	/** `true` while the probe is in flight (access not yet decided) — render nothing, don't 404-flash. */
	readonly loading: boolean;
}

export function useAdminProbe(): AdminAccess {
	const session = useSession();
	const signedIn = !!session.data;
	const {state} = useImperativeView("admin.probe", AdminProbeView, {
		enabled: signedIn,
		deps: [signedIn],
	});
	const granted = state.status === "ok" && !!state.data;
	return {granted, loading: state.status === "loading"};
}
