/**
 * `AdminConsoleRoute` — the `/admin` route element (#2740, epic #2711). It is eagerly in
 * the main bundle (it's a route element), but carries only the admin probe + the lazy
 * console ref — the console shell and every module live behind the `React.lazy` boundary,
 * so a non-admin's bundle never gains console code.
 *
 * Invisible-denial, load-bearing (ADR 0107 / ADR 0098 §2): a caller who isn't a proven
 * admin renders the ORDINARY not-found page — indistinguishable from "this route doesn't
 * exist" — never a 403 or an "you are not an admin" surface. The lazy `AdminConsole`
 * import is reached ONLY in the granted branch, so a non-admin/anonymous visitor's browser
 * never fetches the console chunk. With the `phoenix-admin-console` flag off the probe is
 * never granted, so the route is inert for everyone (ship-dark, ADR 0083).
 */
import {lazy, Suspense} from "react";
import {NotFoundPage} from "../pages/NotFoundPage";
import {useAdminProbe} from "./useAdminProbe.ts";

// Reached only in the granted branch below — a non-admin never triggers this import.
const AdminConsole = lazy(() => import("./AdminConsole.tsx"));

export function AdminConsoleRoute() {
	const {granted, loading} = useAdminProbe();
	// In flight: render nothing rather than flash the not-found page at a legit admin. A
	// non-admin's probe resolves to denied and falls through to NotFoundPage below, so this
	// neutral window leaks nothing.
	if (loading) return null;
	if (!granted) return <NotFoundPage />;
	return (
		<Suspense fallback={null}>
			<AdminConsole />
		</Suspense>
	);
}
