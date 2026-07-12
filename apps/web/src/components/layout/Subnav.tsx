import type * as React from "react";
import {NavLink} from "react-router";
import "./Subnav.css";

export type SubnavFilter = {id: string; label: React.ReactNode};

/**
 * A route-navigating item that sits beside the sort toggles. `end` scopes the
 * NavLink active-match to an exact path so a broader link (e.g. `/pano`) isn't
 * marked active on a nested/decorated route (the default is prefix match).
 */
export type SubnavLink = {to: string; label: React.ReactNode; end?: boolean};

export function Subnav({
	title,
	count,
	filters,
	activeFilter,
	onFilterChange,
	links,
	crumb,
	input,
	meta,
	cta,
}: {
	title?: React.ReactNode;
	count?: React.ReactNode;
	filters?: SubnavFilter[];
	activeFilter?: string;
	onFilterChange?: (id: string) => void;
	links?: SubnavLink[];
	crumb?: {label: React.ReactNode; onClear?: () => void};
	// The input slot (#2602): a product-scoped on-demand utility control — sözlük's
	// go-to-or-create box (distinct from the topbar `ara`, #1669). Left-anchored in the
	// LEADING zone (before the spacer, #2790) so it can't right-jam directly under the
	// topbar's trailing-edge `ara` and read as a second, competing search. Carries the
	// input treatment itself; the slot only positions it (never the filter/CTA treatment,
	// #2586 taxonomy / #2590 IA rule). Absent ⇒ nothing renders.
	input?: React.ReactNode;
	meta?: React.ReactNode;
	// The primary-action slot (placement law #2587): a product's promoted verb (pano/yeni,
	// mecmua yaz) renders here in the dedicated primary-action position. The passed node
	// carries the sanctioned primary-action treatment itself (the `Button` primitive's
	// `primary` variant per the #2586 taxonomy) — the slot only positions it, never the
	// utility filter/tab treatment (#2590). Absent ⇒ nothing renders.
	cta?: React.ReactNode;
}) {
	return (
		<div className="kp-subnav">
			{filters?.length || links?.length ? (
				<div className="kp-subnav__filters">
					{filters?.map((f) => (
						<button
							key={f.id}
							type="button"
							className="kp-subnav__filter"
							aria-pressed={activeFilter === f.id}
							onClick={() => onFilterChange?.(f.id)}
						>
							{f.label}
						</button>
					))}
					{/* NavLink sets aria-current="page" on the active route by default */}
					{links?.map((l) => (
						<NavLink key={l.to} to={l.to} end={l.end} className="kp-subnav__filter">
							{l.label}
						</NavLink>
					))}
				</div>
			) : null}
			{title ? <span className="kp-subnav__title">{title}</span> : null}
			{crumb ? (
				<span className="kp-subnav__crumb">
					{crumb.label}
					{crumb.onClear ? (
						<button type="button" className="kp-subnav__crumb-clear" onClick={crumb.onClear}>
							× filtreyi kaldır
						</button>
					) : null}
				</span>
			) : null}
			{input ? <span className="kp-subnav__input-slot">{input}</span> : null}
			<span className="kp-subnav__spacer" />
			{count ? <span className="kp-subnav__meta">{count}</span> : null}
			{meta ? <span className="kp-subnav__meta">{meta}</span> : null}
			{cta ? <span className="kp-subnav__cta">{cta}</span> : null}
		</div>
	);
}
