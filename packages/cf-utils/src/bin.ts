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
 *   node src/bin.ts auth login                              paste an API token → keychain (#1730)
 *   node src/bin.ts auth status|logout                      inspect / clear stored credentials
 *   node src/bin.ts scrub-author-email --database-id <uuid>            dry-run the email-at-rest scan (#2137)
 *   node src/bin.ts scrub-author-email --database-id <uuid> --execute --confirm scrub-author-email   apply it
 *
 * Credentials resolve keychain-first (`auth login`, #1730), falling back to
 * $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID — the env-var path CI keeps using.
 *
 * `flag set` operates the ACTUAL release lever — the no-match percentage split, never
 * `defaultVariation` (#1726): `--percent N` serves `on` to N% (remainder falls to the safe
 * default), `on` ≡ `--percent 100` (the canonical split form), and `off` is a true kill switch —
 * it clears the split AND sets the default off, so a split-released flag actually stops serving.
 * It DRY-RUNS by default — reads current state, prints the `current → target` diff, and writes
 * NOTHING; the mutation happens only under `--execute` (mirroring orphan-sweep). The lever is
 * agent-invokable (ADR 0134, supersedes 0133): the humans-release boundary (ADR 0083) lives at
 * the `/release` skill + the audit trail, not as a structural TTY refuse here — a non-TTY caller
 * proceeds (logged), a TTY human is prompted to confirm.
 *
 * The thin shell delegates to the pure core (`flag.ts`) via the injectable clients
 * (`flagship.ts`); an unreachable/unauthorized CF surfaces a typed error (rendered by
 * `NodeRuntime.runMain`), never a raw stack trace.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {
	AccountIdKeychainConfig,
	auth,
	CredentialsKeychainFirst,
	KeychainLive,
} from "@kampus/cf-credentials";
import {Console, Effect, Layer} from "effect";
import {Argument, Command, Flag, Prompt} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
	computeEffectiveServing,
	computeServingPlan,
	decideLeverGuard,
	decodeEnv,
	distinctKeys,
	ENV_HELP,
	FlagEnvNotFound,
	FlagKeyNotFound,
	FlagSetTargetInvalid,
	findAppForEnv,
	LeverGuardRefused,
	renderEffectiveServing,
	renderFlagDetail,
	renderFlagTable,
	renderServingPlan,
	type ServeTarget,
	selectStatesForKey,
} from "./flag.ts";
import {FlagshipRead, FlagshipReadLive, FlagshipWrite, FlagshipWriteLive} from "./flagship.ts";
import {makeScrubCommand} from "./scrub-command.ts";

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
	Flag.withDescription(`${ENV_HELP}; omit to read across every env`),
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
const envFlag = Flag.string("env").pipe(Flag.withDescription(ENV_HELP));
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

// The lever's interactive confirm — the thin IO shell around the pure `decideLeverGuard` core, which
// owns the decision semantics (see ADR 0134). Prompts a TTY human `flip <flag> live? [y/N]`; a
// non-TTY agent/CI caller proceeds. Reached ONLY on the `--execute` write branch.
const guardLiveFlip = (
	flagKey: string,
): Effect.Effect<void, LeverGuardRefused, Prompt.Environment> =>
	Effect.gen(function* () {
		const isTTY = process.stdin.isTTY === true;
		if (!isTTY) {
			// Agent / CI: proceed without a prompt, logging the flip for the audit record (ADR 0134).
			yield* Console.log("  live flip executed (non-interactive)");
			return yield* refuse(decideLeverGuard({isTTY: false, confirmResponse: undefined}));
		}
		const response = yield* Prompt.text({message: `flip ${flagKey} live? [y/N]`}).pipe(
			// EOF / Ctrl-D / Ctrl-C at the prompt yields no affirmative answer — collapse to refuse.
			Effect.catchCause(() => Effect.succeed(undefined)),
		);
		return yield* refuse(decideLeverGuard({isTTY: true, confirmResponse: response}));
	});

const refuse = (
	decision: ReturnType<typeof decideLeverGuard>,
): Effect.Effect<void, LeverGuardRefused> =>
	decision._tag === "Allow"
		? Effect.void
		: Effect.fail(new LeverGuardRefused({reason: decision.reason}));

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

		// Lever confirm (ADR 0134) — reached ONLY here, on the changed `--execute` write branch.
		yield* guardLiveFlip(key);

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

// The D1 REST transport layer the scrub verb runs `makeD1Rest` on: the SAME keychain-first
// `Credentials` seam (#1730) the flag surfaces use, plus a Fetch HTTP client — so a founder's
// `auth login` credentials satisfy the D1 REST query API with zero extra wiring, and the
// env-var fallback ($CLOUDFLARE_API_TOKEN) still works for a token-only run.
const ScrubRestLayer = Layer.merge(
	CredentialsKeychainFirst.pipe(Layer.provideMerge(KeychainLive)),
	FetchHttpClient.layer,
).pipe(Layer.provide(NodeServices.layer));

const cli = Command.make("cf-utils").pipe(
	Command.withSubcommands([flag, auth, makeScrubCommand(ScrubRestLayer)]),
	Command.withDescription("Human-operated Cloudflare Flagship read/flip + data-scrub CLI"),
);

// Credentials resolve keychain-first with the env-var fallback (#1730): the same ambient
// `Credentials` seam as before, plus the account-id ConfigProvider so the per-call
// `Config.string("CLOUDFLARE_ACCOUNT_ID")` reads in flagship.ts resolve the keychain too.
// `provideMerge` keeps Keychain visible to the `auth` handlers, and NodeServices supplies the
// spawner/terminal the keychain + prompts run on.
const CredentialLayer = Layer.mergeAll(CredentialsKeychainFirst, AccountIdKeychainConfig).pipe(
	Layer.provideMerge(KeychainLive),
);
const AppLayer = Layer.mergeAll(FlagshipReadLive, FlagshipWriteLive).pipe(
	Layer.provideMerge(Layer.merge(CredentialLayer, FetchHttpClient.layer)),
	Layer.provideMerge(NodeServices.layer),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
