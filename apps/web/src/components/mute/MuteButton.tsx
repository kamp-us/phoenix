/**
 * The inline "sustur" affordance on a member's feed content (#3117, epic #2035). An inline
 * meta-row action (the `ReportButton` / `gizle` idiom — a reset inline `button` styled by
 * `MetaRow`, not a standalone `Button` wrapper), so it reads consistently with the row's
 * other actions. On the feed it is a mute-only action: the instant a member is muted the
 * card unmounts (the overlay hides it), so this control never renders in the muted state —
 * un-muting lives on the manage screen (`MutedMembersList`). The card owns the gating (flag
 * on, signed in, not the viewer's own content) and only mounts this when it can act.
 */
import {useState} from "react";
import {useMemberMute} from "./useMemberMute";

export interface MuteButtonProps {
	/** The member to mute — the `mute.set` target. */
	readonly memberId: string;
	/** The member's displayed handle, for the action's accessible name. */
	readonly memberLabel: string;
	readonly testId?: string;
}

export function MuteButton({memberId, memberLabel, testId}: MuteButtonProps) {
	const {mute} = useMemberMute();
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
		<button
			type="button"
			className="kp-mute-action"
			onClick={onClick}
			disabled={busy}
			aria-busy={busy || undefined}
			aria-label={`${memberLabel} adlı üyeyi sustur`}
			data-testid={testId}
		>
			sustur
		</button>
	);
}
