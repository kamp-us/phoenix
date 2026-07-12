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

/**
 * The membrane mount for the failing-email notice (epic #2687, Child #2693): reads the
 * dark-ship flag and the signed-in user's own failing signal, renders the notice above the
 * routed content, and holds a local per-session dismissal. Dark by default — with the flag off
 * (or no failing signal) it renders nothing, so the membrane is unchanged until a human flips
 * the flag at release (ADR 0083).
 *
 * `me` widens `MeUser` with the forward-compatible `emailFailing` seam ({@link
 * EmailDeliveryReadable}); the caller's plain `me` is assignable, so this is inert until the
 * worker exposes `emailFailing` on the `me` read (Child #2693 AC1).
 */
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
