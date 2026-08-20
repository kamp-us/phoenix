/**
 * The fabrika router wiring — the real bin body, behind `bin.ts`'s bootstrap.
 *
 * It is loaded via a dynamic `import()` from `bin.ts` so an unlinked `catalog:` dep is a catchable
 * `ERR_MODULE_NOT_FOUND` the bin can explain, rather than a raw static-load throw.
 *
 * Wired per effect-smol's CLI guidance: `effect/unstable/cli` for the typed subcommands, the Node
 * platform over `NodeServices.layer`, run via `NodeRuntime.runMain`. The command itself lives in
 * `root-command.ts`; the subcommand set comes straight off `registry.ts`, so `--help` lists exactly
 * what is registered.
 *
 * The one thing that happens before the runner is the unknown-subcommand guard, which the runner
 * cannot do for itself — see `unknown-subcommand.ts` for why (#4822).
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {Command} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {fabrikaCommand} from "./root-command.ts";
import {findUnknownSubcommand, refusal} from "./unknown-subcommand.ts";
import {FAILED} from "./verb.ts";
import {VERSION} from "./version.ts";

const unknown = findUnknownSubcommand(fabrikaCommand, process.argv.slice(2));
if (unknown !== undefined) {
	console.error(refusal(unknown));
	process.exit(FAILED);
}

fabrikaCommand.pipe(
	Command.run({version: VERSION}),
	// `NodeServices.layer` carries the spawner, filesystem, path and terminal but no HTTP client, so
	// the GitHub fetch client (ADR 0315) needs its transport merged in here.
	Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
	NodeRuntime.runMain,
);
