import {useState} from "react";
import type {MeUser} from "../../auth/useMe";
import {PHOENIX_EMAIL_DELIVERY_NOTICE} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {EmailDeliveryNotice} from "./EmailDeliveryNotice";
import {
	EMAIL_RECOVERY_HREF,
	type EmailDeliveryReadable,
	readEmailFailing,
	shouldShowEmailDeliveryNotice,
} from "./emailDeliveryNoticeGate";

// Dark until a human flips the flag at release (ADR 0083). The `me` widening is inert
// until the worker exposes `emailFailing` — see `emailDeliveryNoticeGate`.
export function EmailDeliveryNoticeMount({me}: {me: (MeUser & EmailDeliveryReadable) | null}) {
	const {value: flagOn} = useFlag(PHOENIX_EMAIL_DELIVERY_NOTICE, false);
	const [dismissed, setDismissed] = useState(false);

	if (!shouldShowEmailDeliveryNotice({flagOn, failing: readEmailFailing(me), dismissed})) {
		return null;
	}
	return (
		<EmailDeliveryNotice recoveryHref={EMAIL_RECOVERY_HREF} onDismiss={() => setDismissed(true)} />
	);
}
