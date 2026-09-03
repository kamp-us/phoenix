import {Button} from "@kampus/design";
import {useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {readBootUser} from "../../flags/boot";

/**
 * pano's primary action, signed-in only. The gate reads the edge-resolved
 * `__BOOT__.user` FIRST (ADR 0185) so the CTA paints on the first frame instead of
 * popping in when the session settles, and falls back to the session when `__BOOT__`
 * is absent.
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
