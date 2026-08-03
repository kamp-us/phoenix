/**
 * The fabrika router wiring — the real bin body, behind `bin.ts`'s bootstrap.
 *
 * It is loaded via a dynamic `import()` from `bin.ts` so an unlinked `catalog:` dep is a catchable
 * `ERR_MODULE_NOT_FOUND` the bin can explain, rather than a raw static-load throw.
 *
 * Wired per effect-smol's CLI guidance: `effect/unstable/cli` for the typed subcommands, the Node
 * platform over `NodeServices.layer`, run via `NodeRuntime.runMain`. The subcommand set comes
 * straight off `registry.ts`, so `--help` lists exactly what is registered.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {registeredGroups} from "./registry.ts";
import {VERSION} from "./version.ts";

const cli = Command.make("fabrika").pipe(
	Command.withSubcommands(registeredGroups),
	Command.withDescription(
		"fabrika's deterministic verb package — `fabrika <group> <verb> …`. Stdout is the answer; scope lines and refusals go to stderr; a non-zero exit is UNKNOWN, never a partial answer.",
	),
);

cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
