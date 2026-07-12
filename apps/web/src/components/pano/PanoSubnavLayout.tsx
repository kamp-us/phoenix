import {createContext, type ReactNode, useContext, useState} from "react";
import {Outlet} from "react-router";
import {Subnav, type SubnavFilter} from "../layout/Subnav";
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
 * when it unmounts). Returns null when no zone ancestor provides it — flag off, or the eager
 * public paint above the router (App.tsx) — the signal PanoFeed uses to fall back to rendering
 * its own Subnav exactly as today.
 */
export function useSetPanoSubnavContent() {
	return useContext(SetPanoSubnavContent);
}

/**
 * pano's persistent product Subnav zone (placement law #2587, epic #2596) — the pathless
 * layout-route element that renders pano's Subnav once above the routed `<Outlet>`, so the zone
 * stays mounted across `/pano/*` (no per-page remount). Unlike mecmua's stable destination set,
 * pano's filters/meta/crumb are feed-scoped, so the routed feed publishes them UP via
 * {@link useSetPanoSubnavContent} (the same chip-bridge shape App.tsx uses for the topbar) and
 * this frame owns the state — keeping all feed logic (sort / startTransition / saved variant) in
 * PanoFeed rather than duplicating it here. Mounted only behind the `phoenix-nav-ia` flag
 * (App.tsx); off ⇒ the router is flat and PanoFeed renders its own Subnav as today.
 */
export function PanoSubnavLayout() {
	const [content, setContent] = useState<PanoSubnavContent | null>(null);
	return (
		<SetPanoSubnavContent.Provider value={setContent}>
			<Subnav
				filters={content?.filters}
				activeFilter={content?.activeFilter}
				onFilterChange={content?.onFilterChange}
				crumb={content?.crumb}
				meta={content?.meta}
				cta={<PanoSubnavCta />}
			/>
			<Outlet />
		</SetPanoSubnavContent.Provider>
	);
}
