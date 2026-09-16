import {Outlet, useMatch} from "react-router";
import {sozlukLetterParam} from "../../lib/sozlukLetterParam";
import {SubnavShell} from "../layout/SubnavShell";
import {SozlukAlphabet} from "./index";
import {SozlukSubnavCta} from "./SozlukSubnavCta";

// sözlük's product Subnav zone, composed through `SubnavShell` — see ADR 0182. No search
// slot: the "go to a term" search folded into the global ⌘K `ara` (#2995).
export function SozlukSubnavLayout() {
	// The active letter is the route now, not a query param (#9267), so the strip's current
	// state is read off the path the reader is actually on.
	const match = useMatch("/sozluk/harf/:letter");
	const letter = sozlukLetterParam(match?.params.letter) ?? undefined;
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
