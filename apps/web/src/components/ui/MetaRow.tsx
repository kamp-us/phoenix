import type * as React from "react";
import "./MetaRow.css";

/**
 * The metadata-row primitive (#2163, pillar cohesiveness; epic #2168). Feed rows,
 * post/definition headers, and comment footers each hand-rolled the same inline
 * row — an align-baseline flex-wrap of muted metadata (author · time · a count ·
 * an action or two, dot-separated) — as a near-duplicate copy. `MetaRow` is the
 * one shell those collapse onto: it owns the row layout and the shared child
 * treatment (a bold-secondary `.author`, secondary→accent links, reset inline
 * `button`s), all off role tokens. `MetaRow.Dot` is the shared `·` separator so
 * every surface's separators read identically.
 *
 * A migrating call-site keeps only its own genuine deltas (a bespoke gap, a
 * top-margin) on its own class; the shared shape moves here.
 */
export interface MetaRowProps extends React.HTMLAttributes<HTMLElement> {
	/** Render element (div/footer/header/…). Defaults to `div`. */
	as?: React.ElementType;
}

export function MetaRow({as, className = "", children, ...rest}: MetaRowProps) {
	const Comp = as ?? "div";
	return (
		<Comp className={`kp-meta-row ${className}`.trim()} {...rest}>
			{children}
		</Comp>
	);
}

/** The shared dot separator (`·`), decorative — hidden from assistive tech. */
export function MetaDot() {
	return (
		<span className="kp-meta-row__dot" aria-hidden="true">
			·
		</span>
	);
}

MetaRow.Dot = MetaDot;
