import {Switch as MantiSwitch, type SwitchProps as MantiSwitchProps} from "@manti-ui/react";
import "./Switch.css";

/**
 * @component Switch
 * @whenToUse The Manti-backed binary setting control for an immediately applied
 *   on/off value. Supply a textual child as its label; use CountToggle when a
 *   count travels with the state.
 * @slot children The switch's trailing accessible label.
 */
export function Switch({className = "", ...rest}: MantiSwitchProps) {
	return <MantiSwitch className={`kp-switch ${className}`.trim()} {...rest} />;
}
