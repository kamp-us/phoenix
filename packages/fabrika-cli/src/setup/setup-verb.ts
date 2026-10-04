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
import {defaultFileOf} from "../status/bootstrap-verb.ts";
import {OFF_VOCABULARY} from "../status/codes.ts";
import {ANSWER, answer, refuse, type VerbOutcome} from "../verb.ts";

/**
 * The step that writes the owners file, each row owned by the signed-in login.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10497
 */
export const OWNERS_STEP = "owners-file";

/**
 * The step that writes the starter CI file into a repo with no workflow of its own.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10498
 */
export const CI_STEP = "ci-file";

/**
 * The steps every run walks, in order. None opens a milestone or writes a roadmap: giving work a
 * home is the owner's by-hand step, named in the {@link closing}.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10518
 */
export const SETUP_STEPS = [
	"settings-patch",
	"label-taxonomy",
	"issue-shape-markers",
	"gitignore-row",
	OWNERS_STEP,
	CI_STEP,
] as const;

/** The step `--hand-check` adds after the others. Without the flag it is never run. */
export const HAND_CHECK_STEP = "hand-check-rule";

export type SetupStep = (typeof SETUP_STEPS)[number] | typeof HAND_CHECK_STEP;

/**
 * Whether a run adds {@link HAND_CHECK_STEP}, and the screen paths that step is handed. There is no
 * value for screen paths without the step, so a `--screens` nothing would read cannot be carried.
 */
export type HandCheck =
	| {readonly _tag: "Off"}
	| {readonly _tag: "On"; readonly screens: ReadonlyArray<string>};

/**
 * The two flags as one {@link HandCheck}, or the refusal of `--screens` without `--hand-check`:
 * dropping those paths silently would let the owner believe a screen rule was written.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10537#issuecomment-5985334799
 */
export const handCheckOf = (
	flag: boolean,
	screens: ReadonlyArray<string>,
): HandCheck | {readonly _tag: "Refused"; readonly outcome: VerbOutcome} => {
	if (flag) return {_tag: "On", screens};
	if (screens.length === 0) return {_tag: "Off"};
	return {
		_tag: "Refused",
		outcome: refuse(
			OFF_VOCABULARY,
			"setup: --screens is read only by the hand-check-rule step, which runs under --hand-check. Pass both, or neither. Nothing was written.",
		),
	};
};

export const stepsFor = (handCheck: HandCheck): ReadonlyArray<SetupStep> =>
	handCheck._tag === "On" ? [...SETUP_STEPS, HAND_CHECK_STEP] : SETUP_STEPS;

export interface SetupInput<R> {
	readonly handCheck: HandCheck;
	/** `screens` is empty for every step but {@link HAND_CHECK_STEP}. No step reads stdin. */
	readonly runStep: (
		step: SetupStep,
		screens: ReadonlyArray<string>,
	) => Effect.Effect<VerbOutcome, never, R>;
}

const COMMIT_MESSAGE = "chore: set up fabrika";

/**
 * The step setup leaves to the owner, after the paste lines. It names the guide's by-hand step by its
 * title and no number, since the guide renumbers its steps without a CLI release. It promises nothing
 * of `triage homes`, which refuses in a repo with no open milestone.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10518
 */
export const HOME_NEXT = [
	"Then give work a home: open one milestone and write a roadmap that names it, by hand, as the",
	'getting-started guide\'s step "Give the board a home to put work in" shows.',
];

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
 * The closing of a finished run: what happened, then what to do next. The add line names the file
 * each file-writing step answered with, so it follows a target the repo declared at its own path.
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
	return ["", ...lines, ...paste, ...HOME_NEXT].join("\n");
};

export const runSetup = <R>(input: SetupInput<R>): Effect.Effect<VerbOutcome, never, R> =>
	Effect.gen(function* () {
		const {handCheck} = input;
		const steps = stepsFor(handCheck);
		const rows: Array<string> = [];
		const notices: Array<string> = [];
		for (const step of steps) {
			const screens = step === HAND_CHECK_STEP && handCheck._tag === "On" ? handCheck.screens : [];
			const outcome = yield* input.runStep(step, screens);
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
