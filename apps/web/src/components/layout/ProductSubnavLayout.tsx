import type * as React from "react";
import {Outlet} from "react-router";
import {SubnavShell} from "./SubnavShell";

/**
 * The persistent product Subnav zone (placement law #2587, epic #2596) — a pathless
 * layout-route element per product. It renders the product's subnav bar once above the
 * routed `<Outlet>`, so the zone stays mounted as the user moves within `/<product>/*`
 * (no remount between that product's routes). It composes through `SubnavShell` (ADR 0182)
 * rather than wiring `<Subnav>` directly, so any product on this generic frame inherits the
 * shell's flat element-props and the orphan-as-type-error guarantee. The substrate's `cta`
 * is the shell's `primaryAction` zone (the one promoted verb) — the pano delta #2600 fills it.
 * Mounted only behind the `phoenix-nav-ia` flag (App.tsx) — off ⇒ the router is flat, as today.
 */
export function ProductSubnavLayout({cta}: {cta?: React.ReactNode}) {
	return (
		<>
			<SubnavShell primaryAction={cta} />
			<Outlet />
		</>
	);
}
