import {Outlet, useSearchParams} from "react-router";
import {SubnavShell} from "../layout/SubnavShell";
import {SozlukAlphabet} from "./index";
import {SozlukSubnavCta} from "./SozlukSubnavCta";

/**
 * sözlük's persistent product Subnav zone (placement law #2587, epic #2596), composed through
 * the blessed `SubnavShell` recipe (ADR 0182) — the pathless layout-route element that renders
 * sözlük's Subnav once above the routed `<Outlet>`, so the zone stays mounted across `/sozluk/*`
 * (no per-page remount). The URL-driven alphabet (`?harf=<letter>`) fills the `destinations`
 * zone so it renders INSIDE the bar's filters row; the `+ yeni tanım` create CTA fills the
 * `primaryAction` zone. There is no `utility`/search slot — sözlük's old go-to-or-create box is
 * gone, its "go to a term" search folded into the global ⌘K `ara` (#2995, the #2412 single-search
 * contract), which is why `SubnavShell` omits a `utility` prop (ADR 0182, YAGNI).
 */
export function SozlukSubnavLayout() {
	const [params] = useSearchParams();
	const letter = params.get("harf") ?? undefined;
	return (
		<>
			<SubnavShell
				destinations={<SozlukAlphabet value={letter} />}
				primaryAction={<SozlukSubnavCta />}
			/>
			<Outlet />
		</>
	);
}
