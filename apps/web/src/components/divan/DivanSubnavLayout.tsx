import {createContext, useContext, useState} from "react";
import {Outlet} from "react-router";
import {Subnav, type SubnavFilter} from "../layout/Subnav";

/**
 * The section-switcher content the routed divan page publishes UP into its persistent Subnav
 * zone (#2604): the çaylaklar ↔ raporlar switch as Subnav filters (#2586 taxonomy — the
 * conformant switcher treatment, no resting boxed chrome). Only a moderator has a second
 * section (raporlar is mod-gated), so a non-mod viewer publishes null and the zone shows the
 * bare substrate bar.
 */
export type DivanSubnavContent = {
	filters: SubnavFilter[];
	activeFilter: string;
	onFilterChange: (id: string) => void;
};

const SetDivanSubnavContent = createContext<((content: DivanSubnavContent | null) => void) | null>(
	null,
);

/**
 * The routed divan page calls this to push its section switchers up to the persistent zone
 * (null when it has no switcher, or on unmount). Returns null when no zone ancestor provides it
 * — flag off — the signal DivanWorkspace uses to render its own in-page section nav as today.
 */
export function useSetDivanSubnavContent() {
	return useContext(SetDivanSubnavContent);
}

/**
 * divan's persistent product Subnav zone (placement law #2587, epic #2596) — the pathless
 * layout-route element that renders divan's Subnav once above the routed `<Outlet>`. divan's
 * section switch is page-local state, so the routed page publishes its switchers UP via
 * {@link useSetDivanSubnavContent} (the same publish-up shape pano uses) and this frame holds
 * the state. Mounted only behind the `phoenix-nav-ia` flag (App.tsx); off ⇒ the router is flat
 * and DivanWorkspace renders its own in-page section nav as today.
 */
export function DivanSubnavLayout() {
	const [content, setContent] = useState<DivanSubnavContent | null>(null);
	return (
		<SetDivanSubnavContent.Provider value={setContent}>
			<Subnav
				filters={content?.filters}
				activeFilter={content?.activeFilter}
				onFilterChange={content?.onFilterChange}
			/>
			<Outlet />
		</SetDivanSubnavContent.Provider>
	);
}
