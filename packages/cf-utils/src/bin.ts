#!/usr/bin/env node
/**
 * `cf-utils` — the human-operated Cloudflare Flagship read/flip CLI (`effect/unstable/cli`,
 * mirroring `@kampus/moderator-grant`/`@kampus/orphan-sweep`). Two surfaces today:
 *
 *   node src/bin.ts flag list                              enumerate every flag × env
 *   node src/bin.ts flag get <key> --env <env>             read one flag's state in an env
 *   node src/bin.ts flag get <key>                         read that flag across every env
 *   node src/bin.ts flag set <key> on|off --env <env>      dry-run the served-value flip
 *   node src/bin.ts flag set <key> on|off --env <env> --execute   apply it
 *   $CLOUDFLARE_API_TOKEN   the minted CF token (read by CredentialsFromEnv)
 *   $CLOUDFLARE_ACCOUNT_ID  the account to operate on
 *
 * `flag set` is the human release act (ADR 0083, "agents deploy, humans release"): it flips a
 * flag's served/default value from the terminal instead of the dashboard, scriptably and with
 * a trail. It DRY-RUNS by default — reads current state, prints the `current → target` diff,
 * and writes NOTHING; the mutation happens only under `--execute` (mirroring orphan-sweep). The
 * write must never be invoked by the pipeline autonomously.
 *
 * The thin shell delegates to the pure core (`flag.ts`) via the injectable clients
 * (`flagship.ts`); an unreachable/unauthorized CF surfaces a typed error (rendered by
 * `NodeRuntime.runMain`), never a raw stack trace.
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
	computeFlipPlan,
	decodeEnv,
	distinctKeys,
	FlagEnvNotFound,
	FlagKeyNotFound,
	type FlagTarget,
	findAppForEnv,
	renderFlagDetail,
	renderFlagTable,
	renderFlipPlan,
	selectStatesForKey,
} from "./flag.ts";
import {FlagshipRead, FlagshipReadLive, FlagshipWrite, FlagshipWriteLive} from "./flagship.ts";

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

const keyArg = Argument.string("key").pipe(
	Argument.withDescription("the flag key to flip (e.g. authorship-loop)"),
);
const getKeyArg = Argument.string("key").pipe(
	Argument.withDescription("the flag key to read (e.g. authorship-loop)"),
);
const getEnvFlag = Flag.string("env").pipe(
	Flag.optional,
	Flag.withDescription("the env to read the flag in (e.g. prod); omit for every env"),
);

const get = Command.make(
	"get",
	{key: getKeyArg, env: getEnvFlag},
	Effect.fn(function* ({key, env}) {
		const read = yield* FlagshipRead;

		// No --env: the per-key slice of `flag list` across every env. An unknown key yields an
		// empty slice → fail FlagKeyNotFound (loud, listing the known keys), never a blank table.
		if (env._tag === "None") {
			const rows = yield* read.listFlagStates();
			const slice = selectStatesForKey(rows, key);
			if (slice.length === 0) {
				return yield* new FlagKeyNotFound({key, knownKeys: distinctKeys(rows)});
			}
			yield* Console.log(renderFlagTable(slice));
			return;
		}

		// --env: resolve the app for that env FIRST — an unknown env fails FlagEnvNotFound before
		// the read; then the single-flag read surfaces the SDK's FlagshipFlagNotFound on a bad key.
		const target = env.value;
		const apps = yield* read.listApps();
		const app = findAppForEnv(apps, target);
		if (app === undefined) {
			const knownEnvs = [
				...new Set(apps.map((a) => decodeEnv(a.name)).filter((e): e is string => e !== undefined)),
			].sort();
			return yield* new FlagEnvNotFound({env: target, knownEnvs});
		}
		const flag = yield* read.getAppFlag(app.id, key);
		yield* Console.log(renderFlagDetail(target, flag));
	}),
).pipe(
	Command.withDescription(
		"Read a single flag's state in an env (or across every env when --env is omitted)",
	),
);
const stateArg = Argument.choice("state", ["on", "off"] as const).pipe(
	Argument.withDescription("the served/default value to set — on or off"),
);
const envFlag = Flag.string("env").pipe(
	Flag.withDescription("the env to flip the flag in (e.g. prod)"),
);
const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription(
		"actually apply the flip (default: dry-run — print the diff, write nothing)",
	),
);

const set = Command.make(
	"set",
	{key: keyArg, state: stateArg, env: envFlag, execute: executeFlag},
	Effect.fn(function* ({key, state, env, execute}) {
		const target = state as FlagTarget;
		const read = yield* FlagshipRead;

		// Resolve the app for the env FIRST — an unknown env fails not-found before any read/write.
		const apps = yield* read.listApps();
		const app = findAppForEnv(apps, env);
		if (app === undefined) {
			const knownEnvs = [
				...new Set(apps.map((a) => decodeEnv(a.name)).filter((e): e is string => e !== undefined)),
			].sort();
			return yield* new FlagEnvNotFound({env, knownEnvs});
		}

		// Read the current served variation (an unknown key fails FlagshipFlagNotFound here, still
		// before any write), then compute + render the pure flip plan.
		const current = yield* read.getAppFlag(app.id, key);
		const plan = computeFlipPlan({key, env, currentVariation: current.defaultVariation, target});
		yield* Console.log(renderFlipPlan(plan));

		if (!execute) {
			yield* Console.log("  (dry-run — pass --execute to apply; the flag is unchanged)");
			return;
		}
		if (!plan.changed) {
			yield* Console.log("  (already at target — nothing to write)");
			return;
		}

		const write = yield* FlagshipWrite;
		const updated = yield* write.setFlagDefault({
			appId: app.id,
			flagKey: key,
			targetVariation: target,
		});
		yield* Console.log(`  applied — ${key} @ ${env} now serves "${updated.defaultVariation}"`);
	}),
).pipe(
	Command.withDescription(
		"Flip a flag's served/default value in an env (dry-run by default; --execute to apply)",
	),
);

const flag = Command.make("flag").pipe(
	Command.withSubcommands([list, get, set]),
	Command.withDescription("Read and flip Flagship flags across every env"),
);

const cli = Command.make("cf-utils").pipe(
	Command.withSubcommands([flag]),
	Command.withDescription("Human-operated Cloudflare Flagship read/flip CLI"),
);

// The read + write clients run over the env-credentialed REST transport (the d1-rest
// convention); `provideMerge(NodeServices.layer)` keeps the Node services the CLI runtime
// needs (argv, stdout).
const AppLayer = Layer.mergeAll(FlagshipReadLive, FlagshipWriteLive).pipe(
	Layer.provide(Layer.merge(CredentialsFromEnv, FetchHttpClient.layer)),
	Layer.provideMerge(NodeServices.layer),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
