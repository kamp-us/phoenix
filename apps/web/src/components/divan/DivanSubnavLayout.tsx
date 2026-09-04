import {Button} from "@kampus/design";
import {createContext, useContext, useState} from "react";
import {Outlet} from "react-router";
import type {SubnavFilter} from "../layout/Subnav";
import {SubnavShell} from "../layout/SubnavShell";

/**
 * The section-switcher content the routed divan page publishes UP into its persistent Subnav
 * zone (#2604). Only a moderator has a second section (raporlar is mod-gated), so a non-mod
 * viewer publishes null and the zone shows the bare substrate bar.
 */
export type DivanSubnavContent = {
	filters: SubnavFilter[];
	activeFilter: string;
	onFilterChange: (id: string) => void;
};

const SetDivanSubnavContent = createContext<((content: DivanSubnavContent | null) => void) | null>(
	null,
);

// Returns null when no zone ancestor provides it — the signal DivanWorkspace uses to render
// its own in-page section nav instead.
export function useSetDivanSubnavContent() {
	return useContext(SetDivanSubnavContent);
}

// The shell exposes no typed filters array, so the consumer composes the stateful buttons
// here; SubnavShell's `destinations` zone only positions them INSIDE the bar (ADR 0182).
function DivanSectionSwitcher({filters, activeFilter, onFilterChange}: DivanSubnavContent) {
	return (
		<>
			{filters.map((f) => (
				<Button
					key={f.id}
					type="button"
					variant="link"
					size="sm"
					className="kp-subnav__filter"
					pressed={activeFilter === f.id}
					onClick={() => onFilterChange(f.id)}
				>
					{f.label}
				</Button>
			))}
		</>
	);
}

/**
 * divan's persistent product Subnav zone (placement law #2587, epic #2596) — the pathless
 * layout-route element rendering divan's Subnav once above the routed `<Outlet>`. divan has
 * no promoted verb, so `primaryAction` is absent by design. The section switch is page-local
 * state, so the routed page publishes its switchers UP via {@link useSetDivanSubnavContent}
 * and this frame holds the state.
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
