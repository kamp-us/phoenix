import {NavLink, Outlet} from "react-router";
import {useSession} from "../../auth/client";
import {useMe} from "../../auth/useMe";
import {MECMUA_FEED, MECMUA_PUBLIC_READ, MECMUA_WRITE} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {shouldShowMecmuaWriteCta} from "../../pages/mecmua-write-gate";
import type {SubnavLink} from "../layout/Subnav";
import {SubnavShell} from "../layout/SubnavShell";
import {MecmuaSubnavCta} from "./MecmuaSubnavCta";

// mecmua's product Subnav zone, composed through `SubnavShell` — see ADR 0182.
// Each destination rides the SAME flag its route self-gates on, so a link never points at
// a dark 404 (#2547); yazılarım rides the editor's gate for the same reason.
export function MecmuaSubnavLayout() {
	const session = useSession();
	const {me} = useMe();
	const {value: readOn} = useFlag(MECMUA_PUBLIC_READ, false);
	const {value: feedOn} = useFlag(MECMUA_FEED, false);
	const {value: writeOn} = useFlag(MECMUA_WRITE, false);
	const canAuthor = shouldShowMecmuaWriteCta(writeOn, !!session.data, me?.tier);
	const links: SubnavLink[] = [
		...(readOn ? [{to: "/mecmua", label: "keşfet", end: true}] : []),
		...(feedOn ? [{to: "/mecmua/akis", label: "akış"}] : []),
		...(canAuthor ? [{to: "/mecmua/yazilarim", label: "yazılarım"}] : []),
	];
	return (
		<>
			<SubnavShell
				destinations={
					links.length
						? links.map((l) => (
								<NavLink key={l.to} to={l.to} end={l.end} className="kp-subnav__filter">
									{l.label}
								</NavLink>
							))
						: null
				}
				primaryAction={<MecmuaSubnavCta />}
			/>
			<Outlet />
		</>
	);
}
