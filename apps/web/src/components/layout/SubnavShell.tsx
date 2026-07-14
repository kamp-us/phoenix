import type * as React from "react";
import {Subnav} from "./Subnav";

/**
 * SubnavShell — the blessed shell that owns the whole subnav bar, filters row included.
 *
 * A `recipe` over the `Subnav` primitive that exposes ADR 0176's nav-zone grammar as
 * flat element-props — ONE `ReactNode` prop per zone (ADR 0182). The flat shape is the
 * make-invalid-states-unrepresentable payoff: an element assigned to no declared zone has
 * nowhere to go and is a TYPE error, closing the compound-component orphan-slot class (an
 * element rendered but placed nowhere, detectable only by lint) at the type level — sözlük's
 * alphabet becomes `destinations={…}` inside the bar, never a detached sibling of it.
 *
 * `utility` is deliberately OMITTED (ADR 0182, YAGNI) — re-introducing it is an explicit law
 * change, never a quietly-discovered gap.
 */
export type SubnavShellProps = {
	/** Context / crumb zone (e.g. pano's site/host crumb). */
	leading?: React.ReactNode;
	/**
	 * The single sub-destinations zone. The consumer composes the route-links OR stateful
	 * buttons (mecmua tabs / pano chips / divan sections / sözlük alphabet) inside this one
	 * node; the shell renders it INSIDE the bar, so there is no "next to the bar" slot to
	 * orphan into.
	 */
	destinations?: React.ReactNode;
	/** The ONE promoted verb (mecmua / pano). Absent for divan and sözlük is normal, not a gap. */
	primaryAction?: React.ReactNode;
	/** Meta / count zone (e.g. pano's `N başlık`). */
	signal?: React.ReactNode;
};

export function SubnavShell({leading, destinations, primaryAction, signal}: SubnavShellProps) {
	// Map the four zones onto the wrapped primitive's slots — `primaryAction`→`cta`,
	// `signal`→`meta` (ADR 0182's count→signal merge). No consumer touches `Subnav`'s slots
	// directly; they go through these four zones.
	return <Subnav leading={leading} destinations={destinations} cta={primaryAction} meta={signal} />;
}
