#!/usr/bin/env node
/**
 * `pipeline-cli` — the subcommand-router bin (epic #994, Phase-1 scaffold #996).
 *
 *   node src/bin.ts --help        # list the registered tools
 *   node src/bin.ts version       # the Phase-1 tracer tool
 *   node src/bin.ts <tool> …      # dispatch to a registered tool (Phase-2 children)
 *
 * The router is `Command.withSubcommands(registeredTools)`: the root command
 * carries no behavior of its own, it only dispatches `pipeline-cli <tool> …` to
 * the tool whose `name` matches the first token. A Phase-2 child folds its tool
 * in by appending a `Command` to `registeredTools` in `registry.ts` — this bin
 * and the pure `router.ts` core never change.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/decisions-index` /
 * `@kampus/epic-ledger`): `effect/unstable/cli` for the typed subcommands, the
 * Node platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {registeredTools} from "./registry.ts";
import {VERSION} from "./version.ts";

const cli = Command.make("pipeline-cli").pipe(
	Command.withSubcommands(registeredTools),
	Command.withDescription("The pipeline tooling router — `pipeline-cli <tool> …` (epic #994)"),
);

cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
