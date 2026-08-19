import {Outlet, useSearchParams} from "react-router";
import {SubnavShell} from "../layout/SubnavShell";
import {SozlukAlphabet} from "./index";
import {SozlukSubnavCta} from "./SozlukSubnavCta";

// sözlük's product Subnav zone, composed through `SubnavShell` — see ADR 0182. No search
// slot: the "go to a term" search folded into the global ⌘K `ara` (#2995).
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
