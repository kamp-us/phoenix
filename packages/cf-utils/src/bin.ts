#!/usr/bin/env node
/**
 * `cf-utils` — the human-operated Cloudflare Flagship read/flip CLI (`effect/unstable/cli`,
 * mirroring `@kampus/moderator-grant`/`@kampus/orphan-sweep`). Two surfaces today:
 *
 *   node src/bin.ts flag list                              enumerate every flag × env
 *   node src/bin.ts flag get <key> --env <env>             read one flag's state in an env
 *   node src/bin.ts flag get <key>                         read that flag across every env
 *   node src/bin.ts flag set <key> on --env <env>          dry-run a full release (≡ --percent 100)
 *   node src/bin.ts flag set <key> --percent 50 --env <env>  dry-run a partial ramp
 *   node src/bin.ts flag set <key> off --env <env>         dry-run the kill switch
 *   node src/bin.ts flag set <key> … --env <env> --execute   apply it
 *   node src/bin.ts auth login|status|logout                persist credentials once (keychain)
 *
 * Credentials resolve keychain-first (`auth login`, #1730), falling back to
 * $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID — the env-var path CI keeps using.
 *
 * `flag set` is the human release act (ADR 0083, "agents deploy, humans release"), operating
 * the ACTUAL release lever — the no-match percentage split, never `defaultVariation` (#1726):
 * `--percent N` serves `on` to N% (remainder falls to the safe default), `on` ≡ `--percent
 * 100` (the canonical split form), and `off` is a true kill switch — it clears the split AND
 * sets the default off, so a split-released flag actually stops serving. It DRY-RUNS by
 * default — reads current state, prints the `current → target` diff, and writes NOTHING; the
 * mutation happens only under `--execute` (mirroring orphan-sweep). The write must never be
 * invoked by the pipeline autonomously.
 *
 * The thin shell delegates to the pure core (`flag.ts`) via the injectable clients
 * (`flagship.ts`); an unreachable/unauthorized CF surfaces a typed error (rendered by
 * `NodeRuntime.runMain`), never a raw stack trace.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {auth} from "./auth.ts";
import {AccountIdKeychainConfig, CredentialsKeychainFirst} from "./credentials.ts";
import {
	computeEffectiveServing,
	computeServingPlan,
	decodeEnv,
	distinctKeys,
	FlagEnvNotFound,
	FlagKeyNotFound,
	FlagSetTargetInvalid,
	findAppForEnv,
	renderEffectiveServing,
	renderFlagDetail,
	renderFlagTable,
	renderServingPlan,
	type ServeTarget,
	selectStatesForKey,
} from "./flag.ts";
import {FlagshipRead, FlagshipReadLive, FlagshipWrite, FlagshipWriteLive} from "./flagship.ts";
import {KeychainLive} from "./keychain.ts";

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
	Argument.withDescription("the flag key to release/kill (e.g. authorship-loop)"),
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
	Argument.optional,
	Argument.withDescription(
		"the release target — on (≡ --percent 100) or off (kill: clear the split, default off)",
	),
);
const percentFlag = Flag.integer("percent").pipe(
	Flag.optional,
	Flag.withDescription("the share (0–100) serving on via the no-match split; remainder serves off"),
);
const envFlag = Flag.string("env").pipe(
	Flag.withDescription("the env to release the flag in (e.g. prod)"),
);
const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription(
		"actually apply the release/kill (default: dry-run — print the diff, write nothing)",
	),
);

// Exactly one of `on|off` / `--percent N` names the target; both or neither is a usage error.
const resolveTarget = (
	state: {readonly _tag: "Some"; readonly value: "on" | "off"} | {readonly _tag: "None"},
	percent: {readonly _tag: "Some"; readonly value: number} | {readonly _tag: "None"},
): Effect.Effect<ServeTarget, FlagSetTargetInvalid> => {
	if (state._tag === "Some" && percent._tag === "Some") {
		return Effect.fail(new FlagSetTargetInvalid({reason: 'both "on|off" and --percent given'}));
	}
	if (percent._tag === "Some") {
		if (percent.value < 0 || percent.value > 100) {
			return Effect.fail(
				new FlagSetTargetInvalid({reason: `--percent ${percent.value} is outside 0–100`}),
			);
		}
		return Effect.succeed({_tag: "Percent", percentage: percent.value});
	}
	if (state._tag === "Some") {
		return Effect.succeed(
			state.value === "on" ? {_tag: "Percent", percentage: 100} : {_tag: "Kill"},
		);
	}
	return Effect.fail(new FlagSetTargetInvalid({reason: "no target given"}));
};

const set = Command.make(
	"set",
	{key: keyArg, state: stateArg, percent: percentFlag, env: envFlag, execute: executeFlag},
	Effect.fn(function* ({key, state, percent, env, execute}) {
		const target = yield* resolveTarget(state, percent);
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

		// Read the current envelope (an unknown key fails FlagshipFlagNotFound here, still before
		// any write), then compute + render the pure serving plan.
		const current = yield* read.getAppFlag(app.id, key);
		const plan = computeServingPlan({key, env, flag: current, target});
		yield* Console.log(renderServingPlan(plan));

		if (!execute) {
			yield* Console.log("  (dry-run — pass --execute to apply; the flag is unchanged)");
			return;
		}
		if (!plan.changed) {
			yield* Console.log("  (already at target — nothing to write)");
			return;
		}

		const write = yield* FlagshipWrite;
		const updated = yield* write.setServing({appId: app.id, flagKey: key, target});
		yield* Console.log(
			`  applied — ${key} @ ${env} now serves ${renderEffectiveServing(
				computeEffectiveServing(updated),
			)}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Release a flag via the no-match split (on ≡ --percent 100; off kills; dry-run by default, --execute to apply)",
	),
);

const flag = Command.make("flag").pipe(
	Command.withSubcommands([list, get, set]),
	Command.withDescription("Read and flip Flagship flags across every env"),
);

const cli = Command.make("cf-utils").pipe(
	Command.withSubcommands([flag, auth]),
	Command.withDescription("Human-operated Cloudflare Flagship read/flip CLI"),
);

// Credentials resolve keychain-first with the env-var fallback (#1730): the same ambient
// `Credentials` seam as before, plus the account-id ConfigProvider so the per-call
// `Config.string("CLOUDFLARE_ACCOUNT_ID")` reads in flagship.ts resolve the keychain too.
// `provideMerge` keeps Keychain + HttpClient visible to the `auth` handlers, and
// NodeServices supplies the spawner/terminal the keychain + prompts run on.
const CredentialLayer = Layer.mergeAll(CredentialsKeychainFirst, AccountIdKeychainConfig).pipe(
	Layer.provideMerge(KeychainLive),
);
const AppLayer = Layer.mergeAll(FlagshipReadLive, FlagshipWriteLive).pipe(
	Layer.provideMerge(Layer.merge(CredentialLayer, FetchHttpClient.layer)),
	Layer.provideMerge(NodeServices.layer),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
