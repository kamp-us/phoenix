/**
 * The reaction row's flag-gated slot, shared by the three surfaces the bar
 * renders on (pano post/comment, sözlük definition). It wraps `FlagGate` with a
 * reserved-height fallback so the slot occupies its final height BEFORE the
 * async `phoenix-reactions` gate resolves — otherwise the bar mounts late across
 * every already-laid-out card at once and shoves the feed downward (#2054).
 *
 * The reserved height (`.kp-reaction-slot`) matches the mounted bar's
 * `min-height` (`.kp-reaction-bar`), both sourced from `--reaction-bar-height`
 * in ReactionBar.css, so the swap is exact — no residual shift once reactions
 * load. FlagGate's shared `null` safe-default is untouched: this passes an
 * explicit sized fallback rather than changing the primitive's default.
 */
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
