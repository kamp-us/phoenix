/**
 * A program written with the SDK's authoring API reaches the kernel as a row whose `core` runs the
 * author's code through the SDK's own closures. Their text is the same for every program, so a
 * reload reads the author's code off the row's `authoredCode` instead (#9679 criterion 16).
 */

import {type Answer, defineProgram, program} from "@kampus/tuval-sdk/authoring";
import {describe, expect, it} from "vitest";
import {codeOf} from "./reload.ts";

type Greet = {readonly pokes: number; readonly by: string};

const greet = (edit: {
	readonly start?: string;
	readonly by?: string;
	readonly title?: (state: Greet) => string;
}) =>
	defineProgram(
		program({
			id: "greet",
			ports: {},
			init: edit.start === "v2" ? () => ({pokes: 0, by: "v2"}) : () => ({pokes: 0, by: "v1"}),
			update: {
				poke:
					edit.by === "v2"
						? (state: Greet): Answer<Greet> => [{pokes: state.pokes + 1, by: "v2"}, []]
						: (state: Greet): Answer<Greet> => [{pokes: state.pokes + 1, by: "v1"}, []],
			},
			title: edit.title ?? ((state: Greet) => `greet ${state.pokes}`),
		}),
	);

describe("the code a reload reads off an authored row", () => {
	it("is the same for two compiles of unedited code", () => {
		expect(codeOf(greet({}))).toBe(codeOf(greet({})));
	});

	it("moves with an edit to the author's `init`, `update` cell or derived line", () => {
		const before = codeOf(greet({}));
		expect(codeOf(greet({start: "v2"}))).not.toBe(before);
		expect(codeOf(greet({by: "v2"}))).not.toBe(before);
		expect(codeOf(greet({title: (state) => `hello ${state.pokes}`}))).not.toBe(before);
	});
});
