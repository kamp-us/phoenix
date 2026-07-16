import {describe, expect, it} from "vitest";
import type {ButtonSize, ButtonVariant} from "../../components/ui/Button";
import {
	type BooleanKnob,
	type EnumKnob,
	type KnobForType,
	type KnobSchema,
	type NumberKnob,
	resolveKnobDefaults,
	type StringKnob,
} from "./knob";

// Compile-time soundness — these assertions fail `pnpm typecheck` (tsc) if the knob→prop
// mapping ever drifts. They are the invalid-states-unrepresentable proof, not runtime checks.
type Expect<T extends true> = T;
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// A prop type maps to exactly one knob kind.
type _Bool = Expect<Equal<KnobForType<boolean>, BooleanKnob>>;
type _Num = Expect<Equal<KnobForType<number>, NumberKnob>>;
type _Str = Expect<Equal<KnobForType<string>, StringKnob>>;
// A literal union — the enum case — carries its own union as the knob's value type.
type _Enum = Expect<Equal<KnobForType<ButtonVariant>, EnumKnob<ButtonVariant>>>;
// A non-KnobValue prop (a callback, a node) is unrepresentable as a knob.
type _None = Expect<Equal<KnobForType<() => void>, never>>;

interface DemoProps {
	variant?: ButtonVariant;
	size?: ButtonSize;
	loading?: boolean;
	label?: string;
	onClick?: () => void;
}

// A well-typed schema over DemoProps compiles; the negative cases below must NOT.
const demoSchema: KnobSchema<DemoProps> = {
	variant: {kind: "enum", default: "primary", options: [{value: "primary"}, {value: "secondary"}]},
	loading: {kind: "boolean", default: false},
	label: {kind: "string", default: "hi"},
};

describe("KnobForType — knob-to-prop soundness (compile-time)", () => {
	it("rejects a knob whose kind does not match its prop's type", () => {
		// @ts-expect-error a boolean prop cannot take a string knob
		const wrongKind: KnobSchema<DemoProps> = {loading: {kind: "string", default: "x"}};
		// @ts-expect-error a knob key must be a real prop of the component
		const wrongKey: KnobSchema<DemoProps> = {nope: {kind: "boolean", default: false}};
		const wrongEnum: KnobSchema<DemoProps> = {
			// @ts-expect-error an enum default must be one of the prop's literal values
			variant: {kind: "enum", default: "nope", options: [{value: "primary"}]},
		};
		expect([wrongKind, wrongKey, wrongEnum]).toHaveLength(3);
	});
});

describe("resolveKnobDefaults", () => {
	it("seeds each knob's default keyed by its prop name", () => {
		expect(resolveKnobDefaults(demoSchema)).toEqual({
			variant: "primary",
			loading: false,
			label: "hi",
		});
	});

	it("returns an empty value map for a schema with no knobs", () => {
		expect(resolveKnobDefaults({})).toEqual({});
	});
});
