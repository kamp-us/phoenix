// The sized fallback is not decoration: FlagGate's default `null` has zero height, so the
// bar mounting after the async `phoenix-reactions` gate resolves shoves every laid-out
// card downward at once (#2054). `.kp-reaction-slot` and `.kp-reaction-bar` both take
// their height from `--reaction-bar-height` in ReactionBar.css — keep them in step.
import type {ReactNode} from "react";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_REACTIONS} from "../../flags/keys";
import "./ReactionBar.css";

export function ReactionBarSlot({children}: {children: ReactNode}) {
	return (
		<FlagGate
			flag={PHOENIX_REACTIONS}
			fallback={<div className="kp-reaction-slot" aria-hidden="true" />}
		>
			{children}
		</FlagGate>
	);
}
