import {defineProgram, emit, port, program} from "@kampus/tuval-sdk/authoring";
import {Schema} from "effect";

export const counter = program({
	id: "counter",
	ports: {add: port.in(Schema.Number), total: port.out(Schema.Number)},
	init: () => ({total: 0}),
	update: {
		add: (state, event) => {
			const total = state.total + event.payload;
			return [{total}, [emit("total", total)]];
		},
	},
	title: (state) => `total ${state.total}`,
});

export const counterRow = defineProgram(counter);
