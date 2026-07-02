import type * as React from "react";
import {NavLink} from "react-router";
import "./Subnav.css";

export type SubnavFilter = {id: string; label: React.ReactNode};

/**
 * A route-navigating item that sits beside the sort toggles (e.g. kaydedilenler).
 * `end` scopes the NavLink active-match to an exact path, so a link to `/pano` isn't
 * marked active on the nested `/pano/kaydedilenler` route (the default prefix match).
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
	meta,
}: {
	title?: React.ReactNode;
	count?: React.ReactNode;
	filters?: SubnavFilter[];
	activeFilter?: string;
	onFilterChange?: (id: string) => void;
	links?: SubnavLink[];
	crumb?: {label: React.ReactNode; onClear?: () => void};
	meta?: React.ReactNode;
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
			<span className="kp-subnav__spacer" />
			{count ? <span className="kp-subnav__meta">{count}</span> : null}
			{meta ? <span className="kp-subnav__meta">{meta}</span> : null}
		</div>
	);
}
