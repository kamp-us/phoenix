import {describe, it} from "@effect/vitest";
import {expect, expectTypeOf} from "vitest";
import {type AnyProgram, takesForwardedKeys} from "../registry/program.ts";
import {defineProgram} from "./define-program.ts";
import type {KeyEvent} from "./keys.ts";

interface CounterState {
	readonly count: number;
}

const keyed = defineProgram({
	id: "keyed",
	init: (): CounterState => ({count: 0}),
	update: {
		key: (state: CounterState) => [{count: state.count + 1}, []],
	},
});

const unkeyed = defineProgram({
	id: "unkeyed",
	init: (): CounterState => ({count: 0}),
	update: {
		reset: (state: CounterState) => [{count: 0}, []],
	},
});

const cellFor = (
	row: AnyProgram,
	event: string,
): ((state: unknown, event: unknown) => readonly [unknown, ReadonlyArray<unknown>]) => {
	const cells = row.core.update as Readonly<
		Record<string, (state: unknown, event: unknown) => readonly [unknown, ReadonlyArray<unknown>]>
	>;
	const cell = cells[event];
	if (cell === undefined) throw new Error(`no update cell for "${event}"`);
	return cell;
};

describe("authoring.keys", () => {
	it("answers true for a program whose `update` has a `key` cell", () => {
		expect(takesForwardedKeys(keyed)).toBe(true);
		expect(keyed.takesKeys).toBe(true);
	});

	it("omits `takesKeys` for a program with no `key` cell rather than setting it false", () => {
		expect(takesForwardedKeys(unkeyed)).toBe(false);
		expect(Object.hasOwn(unkeyed, "takesKeys")).toBe(false);
	});

	it("hands the `key` cell the keystroke the shell dispatches", () => {
		// `../shell/host/effects.ts` dispatches exactly this Msg into the focused window's process.
		const [next, effects] = cellFor(keyed, "key")({count: 1}, {type: "key", key: "j"});
		expect(next).toEqual({count: 2});
		expect(effects).toEqual([]);
	});

	it("types the `key` cell's event as the keystroke, not `unknown`", () => {
		defineProgram({
			id: "typed",
			init: (): CounterState => ({count: 0}),
			update: {
				key: (state, event) => {
					expectTypeOf(event).toEqualTypeOf<KeyEvent>();
					expectTypeOf(event).not.toBeAny();
					expectTypeOf(event.key).toEqualTypeOf<string>();
					return [state, []];
				},
			},
		});
	});

	it("refuses an authored `takesKeys` — the flag is the handler's, never the author's", () => {
		defineProgram({
			id: "hand-flagged",
			init: (): CounterState => ({count: 0}),
			// @ts-expect-error `takesKeys` is not a key on the authoring input (#8716 R18.1).
			takesKeys: true,
			update: {
				reset: (state: CounterState) => [state, []],
			},
		});
	});

	it("lets no authored field the compilers do not read reach the row", () => {
		const smuggled = defineProgram({
			// Spread past the literal's excess-property check, so the runtime answer is what is read.
			...({takesKeys: true} as object),
			id: "smuggled",
			init: (): CounterState => ({count: 0}),
			update: {reset: (state: CounterState) => [state, []]},
		});
		expect(Object.hasOwn(smuggled, "takesKeys")).toBe(false);
	});
});
