import type * as React from "react";
import "./MetaRow.css";

/**
 * The metadata-row primitive — see ADR 0162. It owns the row layout and the shared
 * child treatment off role tokens; a migrating call-site keeps only its own deltas.
 *
 * @component MetaRow
 * @whenToUse The muted metadata row shell — author · time · a count · an action,
 *   dot-separated. Reach for it (with `MetaRow.Dot` between items) for any feed
 *   row, post/definition header, or comment footer instead of hand-rolling the row.
 * @slot children The metadata items; separate them with `MetaRow.Dot`.
 */
export interface MetaRowProps extends React.HTMLAttributes<HTMLElement> {
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

export function MetaDot() {
	return (
		<span className="kp-meta-row__dot" aria-hidden="true">
			·
		</span>
	);
}

MetaRow.Dot = MetaDot;
