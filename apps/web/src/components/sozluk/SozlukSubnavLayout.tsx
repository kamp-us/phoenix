import {createContext, useContext, useState} from "react";
import {Outlet, useSearchParams} from "react-router";
import {Subnav} from "../layout/Subnav";
import {SozlukAlphabet} from "./index";
import {SozlukGoToCreate} from "./SozlukGoToCreate";

/**
 * The shared go-to-or-create query, owned by the persistent zone and read DOWN by the
 * routed SozlukHome for its client-side column filter. The box lives in the zone (so a
 * term-to-term jump works mid-browse from any `/sozluk/*` route, term pages included),
 * but SozlukHome still filters its loaded columns by the same typed text — so the zone
 * provides the query rather than owning a box SozlukHome can't see. Null when no zone
 * ancestor provides it (flag off), the signal SozlukHome uses to fall back to its own
 * masthead box + local query state exactly as today.
 */
const SozlukSubnavQuery = createContext<{query: string; setQuery: (q: string) => void} | null>(
	null,
);

export function useSozlukSubnavQuery() {
	return useContext(SozlukSubnavQuery);
}

/**
 * sözlük's persistent product Subnav zone (placement law #2587, epic #2596) — the pathless
 * layout-route element that renders sözlük's Subnav once above the routed `<Outlet>`, so the
 * zone stays mounted across `/sozluk/*` (no per-page remount). The go-to-or-create box (a
 * product-scoped utility, #2586 taxonomy — distinct from the topbar `ara`, #1669) fills the
 * Subnav's `input` slot; the URL-driven alphabet (`?harf=<letter>`) is the filters row, its
 * active-letter accent legal transient state paint left as-is. Mounted only behind the
 * `phoenix-nav-ia` flag (App.tsx); off ⇒ the router is flat and SozlukHome renders its own
 * masthead box + alphabet as today.
 */
export function SozlukSubnavLayout() {
	const [query, setQuery] = useState("");
	const [params] = useSearchParams();
	const letter = params.get("harf") ?? undefined;
	return (
		<SozlukSubnavQuery.Provider value={{query, setQuery}}>
			<Subnav
				input={<SozlukGoToCreate className="kp-subnav__input" query={query} setQuery={setQuery} />}
			/>
			<SozlukAlphabet value={letter} />
			<Outlet />
		</SozlukSubnavQuery.Provider>
	);
}
