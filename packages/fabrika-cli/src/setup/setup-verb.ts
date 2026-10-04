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
import {ANSWER, answer, type VerbOutcome} from "../verb.ts";

/** The steps every run walks, in order. Each needs no input from the caller. */
export const SETUP_STEPS = [
	"settings-patch",
	"label-taxonomy",
	"issue-shape-markers",
	"gitignore-row",
] as const;

/** The step `--hand-check` adds after the others. Without the flag it is never run. */
export const HAND_CHECK_STEP = "hand-check-rule";

export type SetupStep = (typeof SETUP_STEPS)[number] | typeof HAND_CHECK_STEP;

export const stepsFor = (handCheck: boolean): ReadonlyArray<SetupStep> =>
	handCheck ? [...SETUP_STEPS, HAND_CHECK_STEP] : SETUP_STEPS;

export interface SetupInput<R> {
	readonly handCheck: boolean;
	readonly runStep: (step: SetupStep) => Effect.Effect<VerbOutcome, never, R>;
}

const COMMIT_MESSAGE = "chore: set up fabrika";

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** A step's row says `created` in its second cell when the step changed something. */
const changed = (row: string): boolean => row.split("\t")[1] === "created";

/**
 * The closing of a finished run: what happened, then what to do next. The add line names the files
 * the walked steps write, each proven on disk by its own step's answer.
 */
export const closing = (steps: ReadonlyArray<SetupStep>, rows: ReadonlyArray<string>): string => {
	const files = steps.flatMap((step) => defaultFileOf(step) ?? []);
	const made = rows.filter(changed).length;
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
			const outcome = yield* input.runStep(step);
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
