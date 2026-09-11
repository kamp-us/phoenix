/**
 * Shared lane fixtures: the committed coder and chore templates read verbatim (the golden-fixture
 * idiom), and a two-phase document in the /prd-to-tasks shape small enough for a test to mutate.
 */
import {Effect} from "effect";
import type {DriverRouted, ParkCauseSurface, Uncaused} from "../config/keys/park-cause.ts";
import type {Read} from "../config/read-key.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import {answer, type VerbOutcome} from "../verb.ts";
import type {ProveOptions} from "./prove-verb.ts";

/**
 * A prover the test drives, standing in for `runProve` — it records what the verb asked it and
 * answers what the test wants read. `proof: "not-required"` is the shape `lane prove` answers with
 * at exit 0 for an event that claims no artifact, so the default lets an append through.
 *
 * Both appending verbs take their prover as a parameter so their unit tiers stay offline; this is
 * the one stand-in, shared so the driver's path and the shell's are exercised against one fake.
 */
export const fakeProver = (
	outcome: VerbOutcome = answer(JSON.stringify({proof: "not-required"})),
	deferred: ReadonlyArray<string> = [],
	partial: boolean | null = null,
	landed: ReadonlyArray<number> = [],
	diagnosis = false,
) => {
	const asked: ProveOptions[] = [];
	return {
		asked,
		prove: (options: ProveOptions) =>
			Effect.sync(() => {
				asked.push(options);
				return {...outcome, deferred, partial, landed, diagnosis};
			}),
	};
};

/** A `parkCause` read at any arm, for a verb test that does not open a config file. */
export const parkCauseRead = (
	uncaused: Uncaused = "record",
	driverRouted: DriverRouted = "refuse",
): Read<ParkCauseSurface> => ({
	_tag: "Value",
	value: {uncaused, driverRouted},
	note: `test fixture: parkCause.uncaused = ${uncaused}, parkCause.driverRouted = ${driverRouted}`,
});

export const coderTemplateText = (): string =>
	readGoldenFixture(import.meta.url, "./templates/coder.workflow.json");

export const coderWorkflow = (): unknown => JSON.parse(coderTemplateText());

export const choreTemplateText = (): string =>
	readGoldenFixture(import.meta.url, "./templates/chore.workflow.json");

export const choreWorkflow = (): unknown => JSON.parse(choreTemplateText());

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
