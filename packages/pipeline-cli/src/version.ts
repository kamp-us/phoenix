/**
 * The `version` tool — Phase-1 tracer bullet (issue #996).
 *
 * A trivial real subcommand wired end to end so the router seam is exercised by
 * something that runs: `pipeline-cli version` prints the CLI version. It is a
 * normal registered tool (it lives in `registeredTools` like any Phase-2 tool
 * will), not a special case in the router — its only privilege is being the one
 * tool that exists before any real tooling is folded in.
 */
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";

/** The pipeline-cli version string, surfaced both at the root `--version` and here. */
export const VERSION = "0.2.0";

export const versionCommand = Command.make(
	"version",
	{},
	Effect.fn(function* () {
		yield* Console.log(`pipeline-cli ${VERSION}`);
	}),
).pipe(Command.withDescription("Print the pipeline-cli version"));
