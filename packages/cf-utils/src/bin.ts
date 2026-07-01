#!/usr/bin/env node
/**
 * `cf-utils` — the human-operated Cloudflare Flagship read/flip CLI (`effect/unstable/cli`,
 * mirroring `@kampus/moderator-grant`/`@kampus/orphan-sweep`). This slice ships `flag list`:
 * enumerate every Flagship flag across every env and print them as a `flag × env` table.
 *
 *   node src/bin.ts flag list
 *   $CLOUDFLARE_API_TOKEN   the minted CF token (read by CredentialsFromEnv)
 *   $CLOUDFLARE_ACCOUNT_ID  the account to enumerate
 *
 * The thin shell delegates to the pure core (`flag.ts`) via the injectable read client
 * (`flagship.ts`); an unreachable/unauthorized CF surfaces a typed error (rendered by
 * `NodeRuntime.runMain`), never a raw stack trace.
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Command} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {renderFlagTable} from "./flag.ts";
import {FlagshipRead, FlagshipReadLive} from "./flagship.ts";

const list = Command.make(
	"list",
	{},
	Effect.fn(function* () {
		const client = yield* FlagshipRead;
		const rows = yield* client.listFlagStates();
		yield* Console.log(renderFlagTable(rows));
	}),
).pipe(
	Command.withDescription("List every Flagship flag × env (key, env, enabled, default value)"),
);

const flag = Command.make("flag").pipe(
	Command.withSubcommands([list]),
	Command.withDescription("Read Flagship flags across every env"),
);

const cli = Command.make("cf-utils").pipe(
	Command.withSubcommands([flag]),
	Command.withDescription("Human-operated Cloudflare Flagship read/flip CLI"),
);

// The read client runs over the env-credentialed REST transport (the d1-rest convention);
// `provideMerge(NodeServices.layer)` keeps the Node services the CLI runtime needs (argv, stdout).
const AppLayer = FlagshipReadLive.pipe(
	Layer.provide(Layer.merge(CredentialsFromEnv, FetchHttpClient.layer)),
	Layer.provideMerge(NodeServices.layer),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
