import {useCallback, useMemo} from "react";
import {useSearchParams} from "react-router";
import {type AnyKnob, type AnyKnobSchema, type KnobValue, resolveKnobDefaults} from "./knob";
import type {KnobState} from "./useKnobs";

/**
 * The query string is the only copy of knob state — there is no second one to drift. Only knobs
 * that differ from their default are written, and history is `replace`d so twiddling a knob does
 * not stack a back-button trap.
 */
export function useUrlKnobs(schema: AnyKnobSchema): KnobState {
	const [searchParams, setSearchParams] = useSearchParams();
	const defaults = useMemo(() => resolveKnobDefaults(schema), [schema]);

	const values = useMemo(() => {
		const resolved: Record<string, KnobValue> = {...defaults};
		for (const [key, knob] of Object.entries(schema)) {
			const raw = searchParams.get(key);
			if (raw == null) continue;
			const parsed = parseKnobValue(knob, raw);
			if (parsed !== undefined) resolved[key] = parsed;
		}
		return resolved;
	}, [schema, defaults, searchParams]);

	const setKnob = useCallback(
		(key: string, value: KnobValue) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					const knob = schema[key];
					if (knob && sameKnobValue(value, knob.default)) next.delete(key);
					else next.set(key, serializeKnobValue(value));
					return next;
				},
				{replace: true},
			);
		},
		[schema, setSearchParams],
	);

	const reset = useCallback(() => {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				for (const key of Object.keys(schema)) next.delete(key);
				return next;
			},
			{replace: true},
		);
	}, [schema, setSearchParams]);

	return {values, setKnob, reset};
}

function serializeKnobValue(value: KnobValue): string {
	return String(value);
}

function parseKnobValue(knob: AnyKnob, raw: string): KnobValue | undefined {
	switch (knob.kind) {
		case "string":
			return raw;
		case "number": {
			const n = Number(raw);
			return Number.isNaN(n) ? undefined : n;
		}
		case "boolean":
			return raw === "true" ? true : raw === "false" ? false : undefined;
		case "enum": {
			// enum values may be non-string (a number literal), so match on the serialized form
			// and hand back the real option value — never the raw string.
			const option = knob.options.find((o) => serializeKnobValue(o.value) === raw);
			return option?.value;
		}
	}
}

function sameKnobValue(a: KnobValue, b: KnobValue): boolean {
	return serializeKnobValue(a) === serializeKnobValue(b);
}
