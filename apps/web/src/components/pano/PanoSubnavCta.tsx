import {useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {readBootUser} from "../../flags/boot";
import {Button} from "../ui/Button";

/**
 * pano's primary action in its Subnav CTA slot (placement law #2587, epic #2596): the
 * promoted "yeni gönderi" verb, relocated out of the global topbar into the pano product
 * zone. Signed-in only — it replaces the topbar's signed-in `+ gönderi` affordance
 * one-for-one, so a signed-out visitor still reaches auth via the topbar `giriş yap` and
 * sees no CTA. Renders the sanctioned primary-action treatment (`Button` `primary`
 * variant, #2586 taxonomy), never the utility filter/tab styling.
 *
 * The signed-in gate reads the edge-resolved `__BOOT__.user` FIRST (ADR 0185) so the CTA
 * renders on the first frame instead of popping in when the session settles; it falls back to
 * the settling session when `__BOOT__` is absent (flag off / the #2931 never-hang fallback).
 */
export function PanoSubnavCta() {
	const session = useSession();
	const navigate = useNavigate();
	if (readBootUser() == null && !session.data) return null;
	return (
		<Button variant="primary" onClick={() => navigate("/pano/yeni")}>
			yeni gönderi
		</Button>
	);
}
