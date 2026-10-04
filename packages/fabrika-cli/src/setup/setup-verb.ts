/**
 * `fabrika setup` — walk one ordered step list, print each step's own row, and close in plain words.
 *
 * The command owns the order, the stop and the closing. What a step writes, how it reads its target
 * back and which code it refuses on stay the step's: each one is a `status bootstrap` surface run
 * through the caller's `runStep`, and its row and stderr lines pass through unchanged.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10494
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {defaultFileOf, FIRST_MILESTONE_TITLE, milestoneOfTarget} from "../status/bootstrap-verb.ts";
import {ANSWER, answer, type VerbOutcome} from "../verb.ts";

/** The step that makes sure the repo has an open milestone. */
export const MILESTONE_STEP = "first-milestone";

/** The step that writes the roadmap, handed {@link starterRoadmap} over {@link MILESTONE_STEP}'s milestone. */
export const ROADMAP_STEP = "roadmap-focus";

/** The steps every run walks, in order. */
export const SETUP_STEPS = [
	"settings-patch",
	"label-taxonomy",
	"issue-shape-markers",
	"gitignore-row",
	MILESTONE_STEP,
	ROADMAP_STEP,
] as const;

/** The step `--hand-check` adds after the others. Without the flag it is never run. */
export const HAND_CHECK_STEP = "hand-check-rule";

export type SetupStep = (typeof SETUP_STEPS)[number] | typeof HAND_CHECK_STEP;

export const stepsFor = (handCheck: boolean): ReadonlyArray<SetupStep> =>
	handCheck ? [...SETUP_STEPS, HAND_CHECK_STEP] : SETUP_STEPS;

export interface SetupInput<R> {
	readonly handCheck: boolean;
	/** `content` is what the step is handed in place of fd 0, which no step here reads. */
	readonly runStep: (step: SetupStep, content: StdinRead) => Effect.Effect<VerbOutcome, never, R>;
}

/**
 * A new repo's roadmap: one arc row pinning `milestone` by its number, which is the key
 * `triage homes` joins on.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10496
 */
export const starterRoadmap = (milestone: number): string =>
	[
		"## Arcs",
		"",
		"| Arc | Milestone | State |",
		"|---|---|---|",
		`| ${FIRST_MILESTONE_TITLE} | #${milestone} | active |`,
		"",
	].join("\n");

/** A step that takes no content would refuse on its empty-content code rather than wait on a terminal. */
const NO_CONTENT: StdinRead = {_tag: "NoStdin", reason: "fabrika setup reads nothing from stdin"};

const COMMIT_MESSAGE = "chore: set up fabrika";

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** One step's answer as setup reads it: `bootstrap`, the outcome, the step and its target. */
interface StepRow {
	readonly outcome: string | undefined;
	readonly step: string | undefined;
	readonly target: string | undefined;
}

const cellsOf = (row: string): StepRow => {
	const [, outcome, step, target] = row.split("\t");
	return {outcome, step, target};
};

/**
 * What `step` is handed. Only the roadmap takes content, and its one row names the milestone the
 * milestone step's own row answered with, so the number it pins is one that step proved open.
 */
const contentFor = (step: SetupStep, rows: ReadonlyArray<string>): StdinRead => {
	if (step !== ROADMAP_STEP) return NO_CONTENT;
	const target = rows.map(cellsOf).find((row) => row.step === MILESTONE_STEP)?.target;
	const milestone = target === undefined ? null : milestoneOfTarget(target);
	return milestone === null ? NO_CONTENT : {_tag: "Text", text: starterRoadmap(milestone)};
};

/**
 * The closing of a finished run: what happened, then what to do next. The add line names the file
 * each file-writing step answered with, so it follows a roadmap the repo declared at its own path.
 */
export const closing = (steps: ReadonlyArray<SetupStep>, rows: ReadonlyArray<string>): string => {
	const answered = rows.map(cellsOf);
	const files = answered.flatMap(({step, target}) =>
		step !== undefined && target !== undefined && defaultFileOf(step) !== null ? [target] : [],
	);
	const made = answered.filter((row) => row.outcome === "created").length;
	const paste = [
		`  git add ${files.join(" ")}`,
		`  git commit -m "${COMMIT_MESSAGE}"`,
		"  git push -u origin HEAD",
	];
	const lines =
		made === 0
			? [
					`Setup finished: all ${plural(steps.length, "step")} were already done, so this run changed nothing.`,
					"What to do next: nothing, unless the setup files are not committed yet. If they are not, paste these lines:",
				]
			: [
					`Setup finished: ${plural(made, "step")} made changes and ${steps.length - made} ${steps.length - made === 1 ? "was" : "were"} already done. Nothing is committed or pushed yet.`,
					"What to do next: paste these lines to commit and push the setup files:",
				];
	return ["", ...lines, ...paste].join("\n");
};

export const runSetup = <R>(input: SetupInput<R>): Effect.Effect<VerbOutcome, never, R> =>
	Effect.gen(function* () {
		const steps = stepsFor(input.handCheck);
		const rows: Array<string> = [];
		const notices: Array<string> = [];
		for (const step of steps) {
			const outcome = yield* input.runStep(step, contentFor(step, rows));
			notices.push(...outcome.stderr);
			if (outcome.code !== ANSWER) {
				// The finished steps' rows stay on stdout beside the refusing step's code: each is a write
				// that landed, and a re-run answers `exists` for it. The closing is withheld, so a
				// part-finished run never reads as a finished one.
				return {
					code: outcome.code,
					stdout: rows.map((row) => `${row}\n`).join(""),
					stderr: notices,
				};
			}
			rows.push(outcome.stdout.trimEnd());
		}
		return answer([...rows, closing(steps, rows)].join("\n"), notices);
	});
