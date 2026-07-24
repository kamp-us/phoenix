/**
 * The `flag` verb group's `effect/unstable/cli` wiring — the thin IO shell over the local Flagship
 * core (`flagship-core.ts` pure math + renderers, `flagship.ts` read/write clients, #1726). No
 * serving-plan math is re-implemented here: the operator-verb → lever mapping is the only new logic
 * and lives in the pure `./flag.ts` adapter.
 *
 *   anka-ops flag list                            enumerate every flag × env and its serving state
 *   anka-ops flag get <key> [--env <env>]         read a flag's live serving state
 *   anka-ops flag open <key> --env <env>          release on (100% no-match split; --percent N to ramp)
 *   anka-ops flag close <key> --env <env>         kill (clear the split + default off)
 *   anka-ops flag graduate <key>                  verify fully open in prod, file the retirement chore
 *
 * `open`/`close` dry-run by default; the live flip happens only under `--execute`, and a TTY human
 * is confirmed first (the ADR 0134 posture, `posture.ts`). `graduate` never flips — it verifies the
 * flag is fully open and files a `report`-idiom chore (dry-run by default, `--execute` to file).
 */

import {execFileSync} from "node:child_process";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command, Flag, Prompt} from "effect/unstable/cli";
import {
	decideGraduate,
	FlagNotGraduable,
	GRADUATE_ENV,
	releaseVerbToTarget,
	renderRetirementChore,
} from "./flag.ts";
import {FlagshipRead, FlagshipWrite} from "./flagship.ts";
import {
	computeEffectiveServing,
	computeServingPlan,
	decodeEnv,
	distinctKeys,
	ENV_HELP,
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
} from "./flagship-core.ts";
import {decideConfirm} from "./posture.ts";

const keyArg = Argument.string("key").pipe(
	Argument.withDescription("the flag key (e.g. authorship-loop)"),
);
const envFlag = Flag.string("env").pipe(Flag.withDescription(ENV_HELP));
const getEnvFlag = Flag.string("env").pipe(
	Flag.optional,
	Flag.withDescription(`${ENV_HELP}; omit to read across every env`),
);
const percentFlag = Flag.integer("percent").pipe(
	Flag.optional,
	Flag.withDescription("release to N% (0–100) via the no-match split; omit for a full 100% open"),
);
const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription(
		"actually apply (default: dry-run — print what would happen, change nothing)",
	),
);

/** Resolve the Flagship app for `env`, or fail `FlagEnvNotFound` listing the envs that DO resolve. */
const resolveEnvApp = (env: string) =>
	Effect.gen(function* () {
		const read = yield* FlagshipRead;
		const apps = yield* read.listApps();
		const app = findAppForEnv(apps, env);
		if (app === undefined) {
			const knownEnvs = [
				...new Set(apps.map((a) => decodeEnv(a.name)).filter((e): e is string => e !== undefined)),
			].sort();
			return yield* new FlagEnvNotFound({env, knownEnvs});
		}
		return app;
	});

const list = Command.make(
	"list",
	{},
	Effect.fn(function* () {
		const read = yield* FlagshipRead;
		const rows = yield* read.listFlagStates();
		yield* Console.log(renderFlagTable(rows));
	}),
).pipe(
	Command.withDescription("List every Flagship flag × env (key, env, enabled, effective serving)"),
);

const get = Command.make(
	"get",
	{key: keyArg, env: getEnvFlag},
	Effect.fn(function* ({key, env}) {
		const read = yield* FlagshipRead;
		if (env._tag === "None") {
			const rows = yield* read.listFlagStates();
			const slice = selectStatesForKey(rows, key);
			if (slice.length === 0) {
				return yield* new FlagKeyNotFound({key, knownKeys: distinctKeys(rows)});
			}
			yield* Console.log(renderFlagTable(slice));
			return;
		}
		const app = yield* resolveEnvApp(env.value);
		const flag = yield* read.getAppFlag(app.id, key);
		yield* Console.log(renderFlagDetail(env.value, flag));
	}),
).pipe(Command.withDescription("Read a flag's live serving state in an env (or across every env)"));

/**
 * The `--execute` live-flip confirm — the thin IO shell over the pure `decideConfirm` (ADR 0134).
 * Non-TTY proceeds (logged for the audit record); a TTY human proceeds only on an affirmative
 * `y`/`yes`. Reached only on the changed `--execute` write branch of open/close.
 */
export class FlagFlipRefused extends Schema.TaggedErrorClass<FlagFlipRefused>()(
	"@kampus/anka-ops/FlagFlipRefused",
	{reason: Schema.String},
) {
	override get message(): string {
		return `flag flip refused: ${this.reason} — re-run in your terminal and answer the [y/N] confirm with y.`;
	}
}

const confirmFlip = (key: string, env: string) =>
	Effect.gen(function* () {
		const isTTY = process.stdin.isTTY === true;
		if (!isTTY) {
			yield* Console.log("  live flip executed (non-interactive)");
		}
		const response = isTTY
			? yield* Prompt.text({message: `flip ${key} @ ${env} live? [y/N]`}).pipe(
					Effect.catchCause(() => Effect.succeed(undefined)),
				)
			: undefined;
		const decision = decideConfirm({isTTY, confirmResponse: response});
		if (decision._tag === "Refuse") {
			return yield* new FlagFlipRefused({reason: decision.reason});
		}
	});

/**
 * The shared open/close release body: read-before-plan, render the `current → target` diff, and
 * (only under `--execute` on a changed plan, after the confirm) apply the resolved `ServeTarget`.
 * `open` and `close` differ only in the target they resolve — the plan/write/confirm are identical.
 */
const applyServing = (key: string, env: string, target: ServeTarget, execute: boolean) =>
	Effect.gen(function* () {
		const app = yield* resolveEnvApp(env);
		const read = yield* FlagshipRead;
		// Read-before-plan: an unknown key fails FlagshipFlagNotFound here, before any write.
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
		yield* confirmFlip(key, env);
		const write = yield* FlagshipWrite;
		const updated = yield* write.setServing({appId: app.id, flagKey: key, target});
		yield* Console.log(
			`  applied — ${key} @ ${env} now serves ${renderEffectiveServing(computeEffectiveServing(updated))}`,
		);
	});

const open = Command.make(
	"open",
	{key: keyArg, env: envFlag, percent: percentFlag, execute: executeFlag},
	Effect.fn(function* ({key, env, percent, execute}) {
		// Full 100% open by default (the adapter's `open` lever); `--percent N` ramps the split.
		if (percent._tag === "Some" && (percent.value < 0 || percent.value > 100)) {
			return yield* new FlagSetTargetInvalid({
				reason: `--percent ${percent.value} is outside 0–100`,
			});
		}
		const target: ServeTarget =
			percent._tag === "Some"
				? {_tag: "Percent", percentage: percent.value}
				: releaseVerbToTarget("open");
		yield* applyServing(key, env, target, execute);
	}),
).pipe(
	Command.withDescription(
		"Release a flag on via the no-match split (full 100% by default, --percent N to ramp; dry-run by default)",
	),
);

const close = Command.make(
	"close",
	{key: keyArg, env: envFlag, execute: executeFlag},
	Effect.fn(function* ({key, env, execute}) {
		yield* applyServing(key, env, releaseVerbToTarget("close"), execute);
	}),
).pipe(
	Command.withDescription(
		"Kill a flag — clear the no-match split and set the default off (dry-run by default)",
	),
);

/** File the retirement chore via the `report` skill's intake path (`gh`, `status:needs-triage`). */
const fileRetirementChore = (title: string, body: string) =>
	Effect.try({
		try: () =>
			execFileSync(
				"gh",
				["issue", "create", "--title", title, "--body", body, "--label", "status:needs-triage"],
				{encoding: "utf8"},
			).trim(),
		catch: (cause) => new RetirementChoreFileFailed({cause: String(cause)}),
	});

export class RetirementChoreFileFailed extends Schema.TaggedErrorClass<RetirementChoreFileFailed>()(
	"@kampus/anka-ops/RetirementChoreFileFailed",
	{cause: Schema.String},
) {
	override get message(): string {
		return `failed to file the retirement chore via gh: ${this.cause}`;
	}
}

const graduate = Command.make(
	"graduate",
	{key: keyArg, execute: executeFlag},
	Effect.fn(function* ({key, execute}) {
		const read = yield* FlagshipRead;
		const rows = yield* read.listFlagStates();
		const slice = selectStatesForKey(rows, key);
		if (slice.length === 0) {
			return yield* new FlagKeyNotFound({key, knownKeys: distinctKeys(rows)});
		}
		const decision = decideGraduate({key, states: slice});
		if (decision._tag === "Ineligible") {
			return yield* new FlagNotGraduable({key, reason: decision.reason});
		}

		const prod = slice.find((s) => s.env === GRADUATE_ENV);
		yield* Console.log(
			`flag ${key} @ ${GRADUATE_ENV}: ${prod ? renderEffectiveServing(prod.serving) : "(unknown)"} — graduable`,
		);
		const chore = renderRetirementChore(key);
		yield* Console.log(`  retirement chore: "${chore.title}"`);

		if (!execute) {
			yield* Console.log(
				"  (dry-run — pass --execute to file the retirement chore; nothing filed)",
			);
			return;
		}
		const url = yield* fileRetirementChore(chore.title, chore.body);
		yield* Console.log(`  filed retirement chore ${url}`);
	}),
).pipe(
	Command.withDescription(
		"Verify a flag is fully open in prod, then file its retirement chore (never flips; dry-run by default)",
	),
);

export const flag = Command.make("flag").pipe(
	Command.withSubcommands([list, get, open, close, graduate]),
	Command.withDescription("Read and release Flagship flags — the anka-ops operator surface"),
);
