import {useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {useMe} from "../../auth/useMe";
import {MECMUA_WRITE} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {useT} from "../../i18n";
// The gate helper is composer-free (#2523), so consuming it here never drags the tiptap
// editor payload into the entry chunk just to decide whether to offer the write CTA.
import {shouldShowMecmuaWriteCta} from "../../pages/mecmua-write-gate";
import {Button} from "../ui/Button";

export function MecmuaSubnavCta() {
	const session = useSession();
	const {me} = useMe();
	const navigate = useNavigate();
	const {value: writeFlagOn} = useFlag(MECMUA_WRITE, false);
	const t = useT();
	if (!shouldShowMecmuaWriteCta(writeFlagOn, !!session.data, me?.tier)) return null;
	return (
		<Button variant="primary" onClick={() => navigate("/mecmua/yaz")}>
			{t("mecmua.cta.newPost")}
		</Button>
	);
}
