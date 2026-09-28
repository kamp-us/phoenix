/**
 * The two lifecycle fields a restart runs on, and the ruling between them (#8735): `resume` is
 * sugared onto the authored record, `configChanged` is reached by spreading the compiled row.
 *
 * The desk app's `authoring-reload.integration.test.ts` is the same pair on a real kernel; these are the
 * shapes, which is what a reader copying an authored program needs to see without booting one.
 */

import {describe, expect, it} from "@effect/vitest";
import {Schema} from "effect";
import {type Answer, type ArrivalEvent, defineProgram} from "./define-program.ts";
import {emit} from "./effect.ts";
import {port} from "./port.ts";

type State = {readonly seen: number; readonly announced: boolean};

const counter = {
	id: "resume-counter",
	ports: {tick: port.in(Schema.Number), total: port.out(Schema.Number)},
	init: (): State => ({seen: 0, announced: false}),
	update: {
		tick: (state: State, event: ArrivalEvent<"tick", number>): Answer<State> => [
			{...state, seen: state.seen + event.payload},
			[],
		],
		republish: (state: State): Answer<State> => [
			{...state, announced: true},
			[emit("total", state.seen)],
		],
	},
};

describe("authoring.resume is sugared onto the authored record", () => {
	it("compiles the author's own events onto the row the kernel dispatches", () => {
		const row = defineProgram({...counter, resume: () => [{type: "republish" as const}]});
		expect(row.resume?.({seen: 7, announced: false})).toEqual([{type: "republish"}]);
	});

	it("leaves the field off the row entirely when the author declares none", () => {
		expect(defineProgram(counter).resume).toBeUndefined();
	});

	it("carries a state with nothing to resume through as the empty list the row contract wants", () => {
		const row = defineProgram({
			...counter,
			resume: (state: State) => (state.seen === 0 ? [] : [{type: "republish" as const}]),
		});
		expect(row.resume?.({seen: 0, announced: false})).toEqual([]);
	});
});

describe("authoring leaves `configChanged` to a spread", () => {
	// The replacement an author writes by spreading is the raw registry row, which is why this half is
	// not sugared: there is nothing in the authored vocabulary to hand them instead.
	it("is absent from the compiled row", () => {
		const compiled = defineProgram(counter);
		expect(compiled.configChanged, "the layer grew a `configChanged` compiler").toBeUndefined();
	});
});
