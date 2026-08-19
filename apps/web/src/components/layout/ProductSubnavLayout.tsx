import type * as React from "react";
import {Outlet} from "react-router";
import {SubnavShell} from "./SubnavShell";

// A pathless layout route, so the bar stays mounted across a product's child routes (no
// remount). See ADR 0182.
export function ProductSubnavLayout({cta}: {cta?: React.ReactNode}) {
	return (
		<>
			<SubnavShell primaryAction={cta} />
			<Outlet />
		</>
	);
}
