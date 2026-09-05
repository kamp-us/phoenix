import {Button} from "@kampus/design";
import {createContext, type ReactNode, useContext, useState} from "react";
import {Outlet} from "react-router";
import {useT} from "../../i18n";
import type {SubnavFilter} from "../layout/Subnav";
import {SubnavShell} from "../layout/SubnavShell";
import {PanoSubnavCta} from "./PanoSubnavCta";

/**
 * What the routed pano page publishes UP into the persistent Subnav zone. Only the
 * feed routes publish; every other `/pano/*` route leaves the zone with just its CTA.
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
 * Returns null when no zone ancestor provides it (the eager paint above the router) —
 * PanoFeed reads that as the signal to render its own Subnav instead.
 */
export function useSetPanoSubnavContent() {
	return useContext(SetPanoSubnavContent);
}

/** One node for the shell's `destinations` zone; the consumer owns its buttons. See ADR 0182. */
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

/** Plain inline text, deliberately no resting-chrome pill — containment law, #2585. */
function PanoSubnavCrumb({crumb}: {crumb: {label: ReactNode; onClear: () => void}}) {
	const t = useT();
	return (
		<span className="kp-subnav__crumb">
			{crumb.label}
			<Button
				type="button"
				variant="link"
				size="sm"
				className="kp-subnav__crumb-clear"
				onClick={crumb.onClear}
			>
				{t("layout.filter.clear")}
			</Button>
		</span>
	);
}

/**
 * A pathless layout route so the Subnav stays mounted across `/pano/*` — no per-page
 * remount. The feed logic stays in PanoFeed and publishes up. See ADR 0182.
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
