/**
 * Shared lane fixtures: the committed coder template read verbatim (the golden-fixture idiom), and
 * a two-phase document in the /prd-to-tasks shape small enough for a test to mutate.
 */
import {readGoldenFixture} from "../golden-fixture.ts";

export const coderTemplateText = (): string =>
	readGoldenFixture(import.meta.url, "./templates/coder.workflow.json");

export const coderWorkflow = (): unknown => JSON.parse(coderTemplateText());

const region = (ns: string): Record<string, unknown> => ({
	initial: "doing",
	states: {
		doing: {on: {[`${ns}.DONE`]: "checking", [`${ns}.BLOCKED`]: "blocked"}},
		checking: {
			on: {
				[`${ns}.PASS`]: "passed",
				[`${ns}.BLOCKED`]: "blocked",
				[`${ns}.FAIL`]: [
					{target: "doing", guard: `${ns.toLowerCase()}RetriesRemaining`},
					{target: "tripped"},
				],
			},
		},
		blocked: {on: {[`${ns}.UNBLOCKED`]: "hist"}},
		hist: {type: "history"},
		passed: {type: "final"},
		tripped: {type: "final"},
	},
});

/** phase1: two parallel tasks (task_a with maxRetries 2); phase2: one; noErrors gates on both. */
export const twoPhaseWorkflow = (): Record<string, unknown> =>
	JSON.parse(
		JSON.stringify({
			id: "fixture",
			version: 1,
			machine: {
				id: "fixture",
				initial: "phase1",
				context: {
					task_a: {retries: 0, maxRetries: 2, code: true},
					task_b: {retries: 0, maxRetries: 3, code: false},
					task_c: {retries: 0, maxRetries: 3, code: true},
				},
				states: {
					phase1: {
						type: "parallel",
						states: {
							task_a: region("TASK_A"),
							task_b: region("TASK_B"),
						},
						onDone: [{target: "phase2", guard: "noErrors"}, {target: "tripped"}],
					},
					phase2: {
						type: "parallel",
						states: {task_c: region("TASK_C")},
						onDone: [{target: "complete", guard: "noErrors"}, {target: "tripped"}],
					},
					complete: {type: "final"},
					tripped: {type: "final"},
				},
			},
		}),
	);

/** Reach one phase-1 state node of a fixture document, for a test to mutate its `on` map. */
export const stateNode = (
	workflow: Record<string, unknown>,
	task: string,
	state: string,
): {on: Record<string, unknown>} => {
	type Loose = Record<
		string,
		{states: Record<string, {states: Record<string, {on: Record<string, unknown>}>}>}
	>;
	const phases = (workflow.machine as {states: Loose}).states;
	const node = phases.phase1?.states[task]?.states[state];
	if (node === undefined) throw new Error(`fixture holds no state ${task}.${state}`);
	return node;
};
