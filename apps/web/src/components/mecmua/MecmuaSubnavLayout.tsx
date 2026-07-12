import {Outlet} from "react-router";
import {useSession} from "../../auth/client";
import {useMe} from "../../auth/useMe";
import {MECMUA_FEED, MECMUA_PUBLIC_READ, MECMUA_WRITE} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {shouldShowMecmuaWriteCta} from "../../pages/mecmua-write-gate";
import {Subnav, type SubnavLink} from "../layout/Subnav";
import {MecmuaSubnavCta} from "./MecmuaSubnavCta";

/**
 * mecmua's persistent product Subnav zone (placement law #2587, epic #2596) — the pathless
 * layout-route element that hosts mecmua's product destinations + its primary action, so
 * they live in the product zone instead of leaking into the global topbar (#2603). Mounted
 * only behind the `phoenix-nav-ia` flag (App.tsx); off ⇒ the router is flat, exactly as
 * today.
 *
 * Each destination is composed on the SAME flag its route/page self-gates on, so a link
 * never points at a dark 404 (the #2547 "never a dead link" rule): keşfet (the public index)
 * on `mecmua-public-read`, akış (the subscribed-author feed) on `mecmua-feed`, yazılarım
 * (the author's own drafts, #2579's missing home) on the write path. yazılarım rides the
 * same {@link shouldShowMecmuaWriteCta} gate as the CTA (yazar + write live) — gate parity
 * with the editor keeps a çaylak/visitor out of an author-scoped page they can't write to.
 */
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
			<Subnav links={links} cta={<MecmuaSubnavCta />} />
			<Outlet />
		</>
	);
}
