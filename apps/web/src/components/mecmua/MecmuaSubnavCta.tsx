import {useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {useMe} from "../../auth/useMe";
import {MECMUA_WRITE} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
// The gate helper is composer-free (#2523), so consuming it here never drags the tiptap
// editor payload into the entry chunk just to decide whether to offer the write CTA.
import {shouldShowMecmuaWriteCta} from "../../pages/mecmua-write-gate";
import {Button} from "../ui/Button";

/**
 * mecmua's primary action in its Subnav CTA slot (placement law #2587, epic #2596): the
 * promoted "yeni yazı" verb, hosted in the mecmua product zone rather than duplicated as
 * in-page buttons (the #2603 CTA de-dup). Shown exactly when the editor would accept the
 * author — the shared {@link shouldShowMecmuaWriteCta} gate (MECMUA_WRITE live + yazar
 * tier, #2532) — so it never dead-ends a çaylak/visitor into a page they'd be publish-
 * gated on. Renders the sanctioned primary-action treatment (`Button` `primary` variant,
 * #2586 taxonomy), never the utility filter/tab styling.
 */
export function MecmuaSubnavCta() {
	const session = useSession();
	const {me} = useMe();
	const navigate = useNavigate();
	const {value: writeFlagOn} = useFlag(MECMUA_WRITE, false);
	if (!shouldShowMecmuaWriteCta(writeFlagOn, !!session.data, me?.tier)) return null;
	return (
		<Button variant="primary" onClick={() => navigate("/mecmua/yaz")}>
			yeni yazı
		</Button>
	);
}
