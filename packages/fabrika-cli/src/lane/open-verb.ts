/**
 * `lane open` — boot one single-issue lane from the committed coder template, byte-identically.
 *
 * The boot the operator did by hand as `mkdir -p && cp` (#5680, gate-1 friction item 1), as a verb
 * that refuses instead of overwriting: an existing lane dir is a loud {@link LANE_EXISTS}, because
 * resuming needs no boot and a silent overwrite would corrupt a live fold.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {placementRefusal} from "./refusals.ts";
import {type LaneRef, placeMachine} from "./store.ts";

const VERB = "fabrika lane open";

export interface OpenOptions extends LaneRef {
	/** The committed coder template's on-disk path — resolved by the adapter beside this module. */
	readonly templatePath: string;
}

export const runOpen = (
	options: OpenOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const template = yield* Effect.result(readFile(options.templatePath));
		if (Result.isFailure(template)) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the committed template at ${options.templatePath}: ${template.failure.reason} — nothing was booted.`,
			);
		}
		const placed = yield* placeMachine(options, template.success);
		if (placed._tag !== "Placed") return placementRefusal(VERB, placed);
		return answer(
			JSON.stringify({
				answer: "opened",
				lane: options.lane,
				workflow: placed.workflow,
				bytes: new TextEncoder().encode(template.success).length,
			}),
			[`${VERB}: booted ${placed.dir} from ${options.templatePath}.`],
		);
	});
