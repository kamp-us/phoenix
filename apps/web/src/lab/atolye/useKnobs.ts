import * as React from "react";
import {type AnyKnobSchema, type KnobValue, type KnobValues, resolveKnobDefaults} from "./knob";

export interface KnobState {
	readonly values: KnobValues;
	readonly setKnob: (key: string, value: KnobValue) => void;
	readonly reset: () => void;
}

/**
 * The knob-state primitive: seeds from the schema's defaults and updates one knob at a time.
 * Kept separate from the panel so #3093 can lift this state into the URL (deep-linkable knob
 * state) without re-implementing the plumbing.
 */
export function useKnobs(schema: AnyKnobSchema): KnobState {
	const [values, setValues] = React.useState<KnobValues>(() => resolveKnobDefaults(schema));
	const setKnob = React.useCallback((key: string, value: KnobValue) => {
		setValues((prev) => ({...prev, [key]: value}));
	}, []);
	const reset = React.useCallback(() => setValues(resolveKnobDefaults(schema)), [schema]);
	return {values, setKnob, reset};
}
