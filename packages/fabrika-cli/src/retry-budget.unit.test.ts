/**
 * The drift guard on the one retry budget (#5732).
 *
 * `lane/templates/coder.workflow.json` is JSON and cannot import {@link RETRY_BUDGET}, so an edit to
 * the template is exactly how the number quietly grew a second value before. These assertions read
 * the committed bytes and the emitter's output back against the constant, so that edit reds here.
 */
import {describe, expect, it} from "vitest";
import {readGoldenFixture} from "./golden-fixture.ts";
import {emitMachine} from "./lane/emit.ts";
import {coderTemplateText} from "./lane/fixtures.test-support.ts";
import {compileText} from "./lane/machine.ts";
import {RETRY_BUDGET} from "./retry-budget.ts";

const EPIC = 4300;
const CHILDREN = [4301, 4302, 4303].map((number) => ({
	number,
	state: "open" as const,
	stateReason: null,
}));

const epicBody = (): string =>
	readGoldenFixture(import.meta.url, "./lane/__fixtures__/epic-4300.body.txt");

const compiledInitials = (text: string): ReadonlyArray<number> => {
	const compiled = compileText(text);
	if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
	return Object.values(compiled.lane.tasks).map((task) => task.initial.maxRetries);
};

describe("the one retry budget", () => {
	it("is what the committed coder template carries into its compiled task", () => {
		expect(compiledInitials(coderTemplateText())).toEqual([RETRY_BUDGET]);
	});

	it("is what an emitted epic machine carries into every task — each child, and the epic tail", () => {
		const emitted = emitMachine(EPIC, epicBody(), CHILDREN);
		if (emitted._tag !== "Emitted") throw new Error(`expected Emitted, got ${emitted._tag}`);

		expect(compiledInitials(emitted.text)).toEqual(
			[...CHILDREN, "epic tail"].map(() => RETRY_BUDGET),
		);
	});

	it("is the default a task context that declares no budget of its own compiles to", () => {
		const noBudget = JSON.parse(coderTemplateText()) as {
			machine: {context: Record<string, unknown>};
		};
		noBudget.machine.context.issue = {retries: 0};

		expect(compiledInitials(JSON.stringify(noBudget))).toEqual([RETRY_BUDGET]);
	});
});
