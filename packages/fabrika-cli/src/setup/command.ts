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
import {bootstrapStep, repoFlag} from "../status/command.ts";
import {runSetup} from "./setup-verb.ts";

export const setupCommand = leafCommand(
	"setup",
	{
		handCheck: Flag.boolean("hand-check").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"also run the hand-check-rule step, which writes one rule into .fabrika.jsonc (default: not run)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({handCheck, repo}) {
		yield* emit(
			yield* runSetup({
				handCheck,
				runStep: (surfaceId, content) =>
					bootstrapStep({
						surfaceId,
						path: null,
						repo: Option.getOrNull(repo),
						json: false,
						stdin: Effect.succeed(content),
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
			"  closing in plain words with the add, commit and push lines to paste",
			"  A refusing step stops the run on its own code, after the finished steps' rows.",
			"  8: a step's write failed (UNKNOWN)",
			"  9: a step's read-back differs",
			"  11: a step's precondition read failed; that step wrote nothing",
			'  Derivation: the front-door skill\'s contract.md, "setup"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika setup"}]),
);
