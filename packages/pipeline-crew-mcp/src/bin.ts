#!/usr/bin/env node
/**
 * `pipeline-crew-mcp` — the substrate's entry bin (epic #3045, scaffold #3052).
 *
 *   node src/bin.ts            # run the (scaffold-only) root command
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/pipeline-cli`'s bin):
 * `effect/unstable/cli` for the typed command, the Node platform over
 * `NodeServices.layer`, run via `NodeRuntime.runMain`. Scaffold-only today — the
 * root command just reports that no seam behavior is wired yet; children add
 * subcommands as the tracker/peer/edge/crew modules land.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";

import {VERSION} from "./version.ts";

const cli = Command.make(
	"pipeline-crew-mcp",
	{},
	Effect.fn(function* () {
		yield* Console.log(
			`pipeline-crew-mcp ${VERSION} — scaffold; no seam behavior wired yet (epic #3045)`,
		);
	}),
).pipe(Command.withDescription("The crew's channels-backed messaging substrate (epic #3045)"));

cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
