import type * as React from "react";
import {NavLink} from "react-router";
import {Button} from "../ui/Button";
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
	leading,
	destinations,
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
	// Zone slots for the SubnavShell recipe, additive over the older `filters`/`links` arrays
	// the #2973–#2978 migration moves consumers off. See ADR 0182.
	leading?: React.ReactNode;
	destinations?: React.ReactNode;
	crumb?: {label: React.ReactNode; onClear?: () => void};
	// The input slot (#2602): a product-scoped on-demand utility control — sözlük's
	// go-to-or-create box (distinct from the topbar `ara`, #1669). Left-anchored in the
	// LEADING zone (before the spacer, #2790) so it can't right-jam directly under the
	// topbar's trailing-edge `ara` and read as a second, competing search. Carries the
	// input treatment itself; the slot only positions it (never the filter/CTA treatment,
	// #2586 taxonomy / #2590 IA rule). Absent ⇒ nothing renders.
	input?: React.ReactNode;
	meta?: React.ReactNode;
	cta?: React.ReactNode;
}) {
	return (
		<div className="kp-subnav">
			{filters?.length || links?.length || destinations ? (
				<div className="kp-subnav__filters">
					{filters?.map((f) => (
						<Button
							key={f.id}
							type="button"
							variant="link"
							size="sm"
							className="kp-subnav__filter"
							pressed={activeFilter === f.id}
							onClick={() => onFilterChange?.(f.id)}
						>
							{f.label}
						</Button>
					))}
					{/* NavLink sets aria-current="page" on the active route by default */}
					{links?.map((l) => (
						<NavLink key={l.to} to={l.to} end={l.end} className="kp-subnav__filter">
							{l.label}
						</NavLink>
					))}
					{destinations}
				</div>
			) : null}
			{leading ? <span className="kp-subnav__leading">{leading}</span> : null}
			{title ? <span className="kp-subnav__title">{title}</span> : null}
			{crumb ? (
				<span className="kp-subnav__crumb">
					{crumb.label}
					{crumb.onClear ? (
						<Button
							type="button"
							variant="link"
							size="sm"
							className="kp-subnav__crumb-clear"
							onClick={crumb.onClear}
						>
							× filtreyi kaldır
						</Button>
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
