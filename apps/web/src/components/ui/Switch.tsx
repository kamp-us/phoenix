import {Switch as BaseSwitch} from "@base-ui/react/switch";
import type * as React from "react";
import "./Switch.css";

/**
 * @component Switch
 * @whenToUse The on/off toggle primitive (base-ui). Reach for it for a binary
 *   setting that applies immediately; for a toggle that carries a count or defers
 *   until submit, reach for `CountToggle` or a checkbox instead. Name it via an
 *   associated label (it renders no text of its own).
 * @slot thumb The sliding knob (composed internally, not a caller slot).
 */
export function Switch({className = "", ...rest}: React.ComponentProps<typeof BaseSwitch.Root>) {
	return (
		<BaseSwitch.Root className={`kp-switch ${className}`.trim()} {...rest}>
			<BaseSwitch.Thumb className="kp-switch__thumb" />
		</BaseSwitch.Root>
	);
}
