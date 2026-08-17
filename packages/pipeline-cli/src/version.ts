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
import pkg from "../package.json" with {type: "json"};

// Derived, never declared: `package.json` is the one carrier release-please bumps, so a literal
// here would be a second version to hand-sync on every release cut (#5714). Resolves the same
// from `src/` and from `dist/` — npm ships `package.json` in the tarball whatever `files` says.
export const VERSION = pkg.version;

export const versionCommand = Command.make(
	"version",
	{},
	Effect.fn(function* () {
		yield* Console.log(`pipeline-cli ${VERSION}`);
	}),
).pipe(Command.withDescription("Print the pipeline-cli version"));
