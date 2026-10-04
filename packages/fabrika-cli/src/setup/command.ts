/**
 * `fabrika setup` — the one registry entry that runs by itself instead of routing to a verb.
 *
 * The adapter and nothing else: it declares the flags, hands each step to the same runner
 * `status bootstrap` uses, and emits the outcome `./setup-verb.ts` computes.
 *
 * It declares flags only. A command that also carries sub-commands keeps running its own handler
 * when none is named, so sub-commands can be added under `setup` later without renaming this entry.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10494
 */
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import type {StdinRead} from "../io/stdin.ts";
import {bootstrapStep, repoFlag} from "../status/command.ts";
import {handCheckOf, runSetup} from "./setup-verb.ts";

/**
 * What a step is handed in place of fd 0. No step here takes content, so nothing reads this; a step
 * that did would refuse on its empty-content code instead of waiting on a terminal.
 */
const NO_STDIN: StdinRead = {_tag: "NoStdin", reason: "fabrika setup reads nothing from stdin"};

export const setupCommand = leafCommand(
	"setup",
	{
		handCheck: Flag.boolean("hand-check").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"also run the hand-check-rule step, which writes one rule into .fabrika.jsonc (default: not run)",
			),
		),
		screens: Flag.string("screens").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				'with --hand-check only: where the app\'s screens live — a folder ending in "/", or one file such as index.html; repeat it for several. Needed in a repo with no uiSurfaces row',
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({handCheck: flag, screens, repo}) {
		const handCheck = handCheckOf(flag, screens);
		if (handCheck._tag === "Refused") {
			yield* emit(handCheck.outcome);
			return;
		}
		yield* emit(
			yield* runSetup({
				handCheck,
				runStep: (surfaceId, stepScreens) =>
					bootstrapStep({
						surfaceId,
						path: null,
						repo: Option.getOrNull(repo),
						screens: stepScreens,
						json: false,
						stdin: Effect.succeed(NO_STDIN),
					}),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Run the setup steps a new repo needs and say what to do next."),
	Command.withDescription(
		[
			"Runs the setup steps a new repo needs and prints one row per step, then what to do next.",
			"  stdout: `bootstrap\\t<created|exists>\\t<step>\\t<target>\\t<readback>` per step, then the",
			"  closing with the add, commit and push lines to paste",
			"  A refusing step stops the run on its own code.",
			"  8: a step's write failed (UNKNOWN)",
			"  9: a step's read-back differs",
			"  10: --screens refused; nothing written",
			"  11: a step's precondition read failed",
			"  13: --hand-check with no screen file; pass --screens",
			'  Derivation: the front-door skill\'s contract.md, "setup"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika setup"},
		{command: "fabrika setup --hand-check --screens index.html"},
	]),
);
