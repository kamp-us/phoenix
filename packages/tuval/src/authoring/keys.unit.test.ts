import {describe, it} from "@effect/vitest";
import {expect, expectTypeOf} from "vitest";
import {type AnyProgram, takesForwardedKeys} from "../registry/program.ts";
import {defineProgram, program} from "./define-program.ts";
import type {KeyEvent} from "./keys.ts";
import type {ProgramEvent} from "./view.ts";
import type {WindowHost} from "./window.ts";

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

	it("lets a module window type its host at a program that has a `key` cell", () => {
		// Each `=` below is the claim, checked by `tsc` over this file
		// (`.patterns/unconditional-test-assertions.md`, "the type-level sibling"). `KeyedHost`
		// itself is the third claim and the one #9543 reported: it is TS2344 while `KeyEvent` is an
		// interface, because `WindowHost`'s Msg parameter is constrained to the kernel's `Message`.
		expect([keystrokeDispatches, ownEventDispatches, strangerDispatches]).toEqual([
			true,
			true,
			false,
		]);
	});
});

/** The combination #9543 reported: the keyboard opt-in and a module window on one program. */
const keyedWindow = program({
	id: "keyed-window",
	init: (): CounterState => ({count: 0}),
	update: {
		bump: (state: CounterState) => [{count: state.count + 1}, []],
		key: (state: CounterState, event) => [{count: state.count + (event.key === "-" ? -1 : 1)}, []],
	},
	renderer: {kind: "module", ref: "/src/demo/module-window.tsx"},
});

/** The host that program's window types its dispatch at, exactly as `../demo/module-window.tsx` does. */
type KeyedHost = WindowHost<
	CounterState,
	ProgramEvent<Record<string, never>, (typeof keyedWindow)["update"]>
>;

/** Does that host's dispatch still take this event — narrow, rather than widened to `Message`? */
type Dispatches<E> = KeyedHost["dispatch"] extends (msg: E) => unknown ? true : false;

const keystrokeDispatches: Dispatches<KeyEvent> = true;
const ownEventDispatches: Dispatches<{readonly type: "bump"}> = true;
const strangerDispatches: Dispatches<{readonly type: "unheard"}> = false;
