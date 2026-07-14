import type * as React from "react";
import "./PageShell.css";

/**
 * PageShell — the recipe that names a product page's vertical zone-stack once (ADR 0182):
 * the persistent Subnav zone on top, the routed page content below. A product page is a
 * PageShell, so the subnav-plus-content shape is named once, not rebuilt as ad-hoc JSX per
 * surface. It composes `SubnavShell` as that top zone — PageShell owns the page's VERTICAL
 * anatomy (subnav above content); SubnavShell owns the bar's horizontal zones and composes
 * into the `subnav` slot.
 *
 * Same flat element-props idiom as SubnavShell — ONE `ReactNode` prop per zone — so an element
 * assigned to no declared zone has nowhere to go and is a TYPE error, closing the
 * compound-component orphan-slot class at the type level.
 */
export type PageShellProps = {
	/** The persistent Subnav zone on top — a `SubnavShell` composes here (ADR 0182). */
	subnav?: React.ReactNode;
	/** The routed page content below the subnav (typically the router `<Outlet>`). */
	content?: React.ReactNode;
};

export function PageShell({subnav, content}: PageShellProps) {
	return (
		<div className="kp-page-shell">
			{subnav}
			{content}
		</div>
	);
}
