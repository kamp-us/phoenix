import {createContext, type ReactNode, useContext, useState} from "react";
import {Outlet} from "react-router";
import type {SubnavFilter} from "../layout/Subnav";
import {SubnavShell} from "../layout/SubnavShell";
import {PanoSubnavCta} from "./PanoSubnavCta";

/**
 * The feed-scoped content the routed pano page publishes UP into its persistent Subnav zone.
 * Per the #2586 taxonomy: `filters` are pano's product filters (the sort subfeeds +
 * kaydedilenler), `meta` is a read-only count signal, `crumb` is the active site-filter shown
 * as transient state paint (legal — it paints only while a `/pano/site/:host` filter is active,
 * like the sözlük active-letter accent), and the CTA slot (below) holds the primary action.
 * Only the pano feed routes publish; on the other `/pano/*` routes the zone shows just its CTA.
 */
export type PanoSubnavContent = {
	filters: SubnavFilter[];
	activeFilter: string;
	onFilterChange: (id: string) => void;
	meta: ReactNode;
	crumb?: {label: ReactNode; onClear: () => void};
};

const SetPanoSubnavContent = createContext<((content: PanoSubnavContent | null) => void) | null>(
	null,
);

/**
 * The routed pano feed calls this to push its Subnav content up to the persistent zone (null
 * when it unmounts). Returns null when no zone ancestor provides it — the eager public paint
 * above the router (App.tsx) — the signal PanoFeed uses to fall back to rendering its own
 * Subnav.
 */
export function useSetPanoSubnavContent() {
	return useContext(SetPanoSubnavContent);
}

/**
 * pano's sort/filter chips, composed as one node for the shell's `destinations` zone. The consumer
 * owns rendering its stateful buttons inside that single zone (ADR 0182) — the `kp-subnav__filter`
 * class carries the shared tab treatment, `aria-pressed` marks the active subfeed.
 */
function PanoSubnavFilters({
	filters,
	activeFilter,
	onFilterChange,
}: {
	filters: SubnavFilter[];
	activeFilter: string;
	onFilterChange: (id: string) => void;
}) {
	return (
		<>
			{filters.map((f) => (
				<button
					key={f.id}
					type="button"
					className="kp-subnav__filter"
					aria-pressed={activeFilter === f.id}
					onClick={() => onFilterChange(f.id)}
				>
					{f.label}
				</button>
			))}
		</>
	);
}

/**
 * The active site-filter as a transient crumb for the shell's `leading` (context) zone — plain
 * inline text + the `× filtreyi kaldır` clear, no resting-chrome pill (containment law, #2585).
 */
function PanoSubnavCrumb({crumb}: {crumb: {label: ReactNode; onClear: () => void}}) {
	return (
		<span className="kp-subnav__crumb">
			{crumb.label}
			<button type="button" className="kp-subnav__crumb-clear" onClick={crumb.onClear}>
				× filtreyi kaldır
			</button>
		</span>
	);
}

/**
 * pano's persistent product Subnav zone (placement law #2587, epic #2596) — the pathless
 * layout-route element that renders pano's Subnav once above the routed `<Outlet>`, so the zone
 * stays mounted across `/pano/*` (no per-page remount). Composes through {@link SubnavShell}
 * (ADR 0182): pano's feed-scoped content maps onto the shell's typed zones — the crumb into
 * `leading`, the sort/filter chips into `destinations`, `PanoSubnavCta` into `primaryAction`, and
 * the count into `signal`. The routed feed publishes that content UP via
 * {@link useSetPanoSubnavContent} (the same chip-bridge shape App.tsx uses for the topbar) and this
 * frame owns the state — keeping all feed logic (sort / startTransition / saved variant) in
 * PanoFeed rather than duplicating it here.
 */
export function PanoSubnavLayout() {
	const [content, setContent] = useState<PanoSubnavContent | null>(null);
	return (
		<SetPanoSubnavContent.Provider value={setContent}>
			<SubnavShell
				leading={content?.crumb ? <PanoSubnavCrumb crumb={content.crumb} /> : undefined}
				destinations={
					content?.filters?.length ? (
						<PanoSubnavFilters
							filters={content.filters}
							activeFilter={content.activeFilter}
							onFilterChange={content.onFilterChange}
						/>
					) : undefined
				}
				primaryAction={<PanoSubnavCta />}
				signal={content?.meta}
			/>
			<Outlet />
		</SetPanoSubnavContent.Provider>
	);
}
