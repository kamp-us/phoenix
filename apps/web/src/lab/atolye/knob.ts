/**
 * prop-knobs — the typed knob schema that live-drives an exhibit's props.
 *
 * A knob is one on-screen control (`string`→text · `number`→number · `boolean`→Switch ·
 * `enum`→ToggleGroup) bound to one host-component prop. The one non-obvious thing:
 * `KnobForType` parameterizes each knob over its prop's type so a knob can only target a
 * real prop AND can only carry a value assignable to it — the invalid-states-unrepresentable
 * guarantee lives in this file's type layer, not in a runtime check.
 */

/** The only value kinds a knob produces — everything reachable through a control. */
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

/**
 * The knob a prop of type `T` admits — the soundness core. A prop can only be knobbed
 * when its type reduces to a `KnobValue`; anything else (`ReactNode`, a callback) maps to
 * `never`, so it is unrepresentable in a schema and must be supplied via `fixedProps`.
 * An open `string` gets a text knob; a string/number literal union gets an enum whose
 * options are drawn from that exact union.
 */
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

/** A per-prop knob map over a component's props `P` — a knob key must be a real prop of `P`. */
export type KnobSchema<P> = {
	readonly [K in keyof P]?: KnobForType<NonNullable<P[K]>>;
};

/** The type-erased runtime shapes — what the presentational layer switches on. */
export type AnyKnob = StringKnob | NumberKnob | BooleanKnob | EnumKnob;
export type AnyKnobSchema = Readonly<Record<string, AnyKnob>>;

/** Current knob values keyed by prop name — the object spread onto the host component. */
export type KnobValues = Readonly<Record<string, KnobValue>>;

/** The initial value map for a schema: each knob's `default`, keyed by its prop name. */
export function resolveKnobDefaults(schema: AnyKnobSchema): KnobValues {
	const values: Record<string, KnobValue> = {};
	for (const [key, knob] of Object.entries(schema)) {
		values[key] = knob.default;
	}
	return values;
}
