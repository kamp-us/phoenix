// prop-knobs — one typed control per host-component prop. See .patterns/atolye-exhibit-harness.md

export type KnobValue = string | number | boolean;

export interface StringKnob {
	readonly kind: "string";
	readonly label?: string;
	readonly default: string;
	readonly placeholder?: string;
}

export interface NumberKnob {
	readonly kind: "number";
	readonly label?: string;
	readonly default: number;
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
}

export interface BooleanKnob {
	readonly kind: "boolean";
	readonly label?: string;
	readonly default: boolean;
}

export interface EnumOption<V extends KnobValue> {
	readonly value: V;
	/** Turkish display label for the option; falls back to `String(value)`. */
	readonly label?: string;
}

export interface EnumKnob<V extends KnobValue = KnobValue> {
	readonly kind: "enum";
	readonly label?: string;
	readonly default: V;
	readonly options: readonly EnumOption<V>[];
}

/** A prop whose type is not a `KnobValue` maps to `never` — unknobbable, so it must go through `fixedProps`. */
export type KnobForType<T> = [T] extends [boolean]
	? BooleanKnob
	: [T] extends [number]
		? number extends T
			? NumberKnob
			: EnumKnob<T & KnobValue>
		: [T] extends [string]
			? string extends T
				? StringKnob
				: EnumKnob<T & KnobValue>
			: never;

export type KnobSchema<P> = {
	readonly [K in keyof P]?: KnobForType<NonNullable<P[K]>>;
};

export type AnyKnob = StringKnob | NumberKnob | BooleanKnob | EnumKnob;
export type AnyKnobSchema = Readonly<Record<string, AnyKnob>>;

export type KnobValues = Readonly<Record<string, KnobValue>>;

/**
 * The param is `Partial<AnyKnobSchema>`, not `AnyKnobSchema`, so a raw authored
 * `KnobSchema<P>` is accepted at the public boundary without a cast: `KnobSchema<P>` maps
 * each prop optionally (`[K in keyof P]?`), so its erased values are `AnyKnob | undefined` —
 * the widened param is the common supertype of that and the runtime `AnyKnobSchema`.
 */
export function resolveKnobDefaults(schema: Partial<AnyKnobSchema>): KnobValues {
	const values: Record<string, KnobValue> = {};
	for (const [key, knob] of Object.entries(schema)) {
		if (!knob) continue;
		values[key] = knob.default;
	}
	return values;
}
