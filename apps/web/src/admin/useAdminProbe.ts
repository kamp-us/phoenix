/**
 * Fail-closed by construction: it probes only for a signed-in viewer, and any error — the
 * `Denied` denial or a transport failure — reports not-granted. The grant is the server's
 * `requireAdmin` verdict and nothing else; this hook cannot widen it.
 *
 * Imperative (`useImperativeView`, not a suspending read) like `useMe`/`useDivanAccess`: the
 * probe drives a route element that must resolve to a safe default rather than suspend.
 */

import {view} from "react-fate";
import type {AdminProbe} from "../../worker/features/admin-console/probe-view";
import {useSession} from "../auth/client";
import {useImperativeView} from "../fate/useImperativeView";

const AdminProbeView = view<AdminProbe>()({id: true, admin: true});

export interface AdminAccess {
	readonly granted: boolean;
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
