import type * as React from "react";
import {Outlet} from "react-router";
import {Subnav} from "./Subnav";

/**
 * The persistent product Subnav zone (placement law #2587, epic #2596) — a pathless
 * layout-route element per product. It renders the product's `<Subnav>` once above the
 * routed `<Outlet>`, so the zone stays mounted as the user moves within `/<product>/*`
 * (no remount between that product's routes). The substrate (#2598) mounts an empty zone
 * frame; each per-product delta (#2600–#2604) fills its destinations / filters / CTA by
 * passing the matching `<Subnav>` slot here (the pano delta #2600 fills `cta`).
 * Mounted only behind the `phoenix-nav-ia` flag (App.tsx) — off ⇒ the router is flat, as
 * today.
 */
export function ProductSubnavLayout({cta}: {cta?: React.ReactNode}) {
	return (
		<>
			<Subnav cta={cta} />
			<Outlet />
		</>
	);
}
