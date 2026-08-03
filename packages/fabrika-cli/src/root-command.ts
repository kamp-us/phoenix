/**
 * The root `fabrika` command — the definition, separated from the wiring that runs it.
 *
 * `run.ts` executes on import, so anything that needs the command *object* (the unknown-subcommand
 * guard, and the tests that resolve argv against the real tree) cannot get it from there. This module
 * is importable without starting a CLI, which is what lets a test walk the same tree the runner
 * parses instead of a parallel copy of it.
 */
import {Command} from "effect/unstable/cli";
import {registeredGroups} from "./registry.ts";

export const fabrikaCommand = Command.make("fabrika").pipe(
	Command.withSubcommands(registeredGroups),
	Command.withDescription(
		"fabrika's deterministic verb package — `fabrika <group> <verb> …`. Stdout is the answer; scope lines and refusals go to stderr; a non-zero exit is UNKNOWN, never a partial answer.",
	),
);
