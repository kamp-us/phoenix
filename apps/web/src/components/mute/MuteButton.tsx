// Mute-only by design: the card unmounts the instant a member is muted, so there is no
// muted state to render here — un-muting lives on `MutedMembersList`. The card also owns
// the gating (flag on, signed in, not the viewer's own content) and only mounts this
// button when it can act, which is why there is no check for any of that below.
import {useState} from "react";
import {useT} from "../../i18n";
import {Button} from "../ui/Button";
import {useMemberMute} from "./useMemberMute";

export interface MuteButtonProps {
	readonly memberId: string;
	readonly memberLabel: string;
	readonly testId?: string;
}

export function MuteButton({memberId, memberLabel, testId}: MuteButtonProps) {
	const {mute} = useMemberMute();
	const t = useT();
	const [busy, setBusy] = useState(false);

	async function onClick() {
		if (busy) return;
		setBusy(true);
		// On success the card unmounts under us (the overlay hides it); on failure the card
		// stays and the button re-enables so the action is retryable.
		const {ok} = await mute(memberId);
		if (!ok) setBusy(false);
	}

	return (
		<Button
			type="button"
			variant="link"
			size="sm"
			className="kp-mute-action"
			onClick={onClick}
			disabled={busy}
			aria-busy={busy || undefined}
			aria-label={t("mute.action.label", {member: memberLabel})}
			data-testid={testId}
		>
			{t("mute.action")}
		</Button>
	);
}
