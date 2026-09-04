import {Switch as MantiSwitch, type SwitchProps as MantiSwitchProps} from "@manti-ui/react";
import {useCallback, useEffect, useReducer, useRef} from "react";
import "./Switch.css";

/**
 * @component Switch
 * @whenToUse The Manti-backed binary setting control for an immediately applied
 *   on/off value. Supply a textual child as its label; use CountToggle when a
 *   count travels with the state.
 * @slot children The switch's trailing accessible label.
 */
export function Switch({className = "", checked, onCheckedChange, ...rest}: MantiSwitchProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [, requestSync] = useReducer((n: number) => n + 1, 0);

	// Zag's switch machine renders its hidden input uncontrolled: getHiddenInputProps()
	// emits `defaultChecked`, never a React-owned `checked` (@zag-js/switch@1.43.0,
	// dist/switch.connect.mjs). So a click flips input.checked in the DOM and a later
	// programmatic change updates every data-state while leaving that property stale —
	// and the property is what assistive tech reads off role="switch". Re-assert it on
	// every render, and force a render on every attempted change so a flip the parent
	// declines (checked prop unchanged, so no render of its own) is corrected too.
	useEffect(() => {
		const input = inputRef.current;
		if (input && checked !== undefined && input.checked !== checked) {
			input.checked = checked;
		}
	});

	const handleCheckedChange = useCallback(
		(next: boolean) => {
			requestSync();
			onCheckedChange?.(next);
		},
		[onCheckedChange],
	);

	return (
		<MantiSwitch
			ref={inputRef}
			className={`kp-switch ${className}`.trim()}
			checked={checked}
			onCheckedChange={handleCheckedChange}
			{...rest}
		/>
	);
}
