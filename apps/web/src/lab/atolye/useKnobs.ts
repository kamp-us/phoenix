import * as React from "react";
import {type AnyKnobSchema, type KnobValue, type KnobValues, resolveKnobDefaults} from "./knob";

export interface KnobState {
	readonly values: KnobValues;
	readonly setKnob: (key: string, value: KnobValue) => void;
	readonly reset: () => void;
}

/** Kept separate from the panel so the detail route can swap in URL-backed state (`useUrlKnobs`). */
export function useKnobs(schema: AnyKnobSchema): KnobState {
	const [values, setValues] = React.useState<KnobValues>(() => resolveKnobDefaults(schema));
	const setKnob = React.useCallback((key: string, value: KnobValue) => {
		setValues((prev) => ({...prev, [key]: value}));
	}, []);
	const reset = React.useCallback(() => setValues(resolveKnobDefaults(schema)), [schema]);
	return {values, setKnob, reset};
}
