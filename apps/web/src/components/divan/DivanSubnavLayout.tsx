import {createContext, useContext, useState} from "react";
import {Outlet} from "react-router";
import type {SubnavFilter} from "../layout/Subnav";
import {SubnavShell} from "../layout/SubnavShell";

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

// The switcher buttons carry the #2586 taxonomy filter treatment themselves (`.kp-subnav__filter`
// + aria-pressed) — SubnavShell's `destinations` zone only positions them INSIDE the bar (ADR
// 0182), never a detached sibling row. The shell exposes no typed filters array, so the consumer
// composes the stateful buttons here.
function DivanSectionSwitcher({filters, activeFilter, onFilterChange}: DivanSubnavContent) {
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
 * divan's persistent product Subnav zone (placement law #2587, epic #2596) — the pathless
 * layout-route element that renders divan's Subnav once above the routed `<Outlet>`. Composes
 * through {@link SubnavShell} (ADR 0182): the section switch lands in the `destinations` zone
 * inside the bar, and divan has no promoted verb, so `primaryAction` is absent by design.
 * divan's section switch is page-local state, so the routed page publishes its switchers UP via
 * {@link useSetDivanSubnavContent} (the same publish-up shape pano uses) and this frame holds
 * the state. Mounted only behind the `phoenix-nav-ia` flag (App.tsx); off ⇒ the router is flat
 * and DivanWorkspace renders its own in-page section nav as today.
 */
export function DivanSubnavLayout() {
	const [content, setContent] = useState<DivanSubnavContent | null>(null);
	return (
		<SetDivanSubnavContent.Provider value={setContent}>
			<SubnavShell destinations={content ? <DivanSectionSwitcher {...content} /> : undefined} />
			<Outlet />
		</SetDivanSubnavContent.Provider>
	);
}
