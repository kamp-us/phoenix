/**
 * Invisible denial, load-bearing (ADR 0107, ADR 0098 §2): a caller who isn't a proven admin
 * renders the ORDINARY not-found page — never a 403 or an "you are not an admin" surface.
 * The lazy `AdminConsole` import is reached only in the granted branch, so a non-admin's
 * browser never fetches the console chunk.
 */
import {lazy, Suspense} from "react";
import {NotFoundPage} from "../pages/NotFoundPage";
import {useAdminProbe} from "./useAdminProbe.ts";

const AdminConsole = lazy(() => import("./AdminConsole.tsx"));

export function AdminConsoleRoute() {
	const {granted, loading} = useAdminProbe();
	// Render nothing in flight rather than flash not-found at a legit admin; a non-admin's
	// probe resolves to denied and falls through to NotFoundPage, so this window leaks nothing.
	if (loading) return null;
	if (!granted) return <NotFoundPage />;
	return (
		<Suspense fallback={null}>
			<AdminConsole />
		</Suspense>
	);
}
