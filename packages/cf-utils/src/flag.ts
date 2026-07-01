/**
 * `@kampus/cf-utils` pure core — IO-free, total transforms over already-listed Flagship
 * data. Two decodes and one renderer, so the read client (`flagship.ts`) and bin (`bin.ts`)
 * stay thin and every branch here is unit-testable off-network:
 *
 *   - `decodeEnv` turns a Flagship app's PHYSICAL name back into its stage/env, or
 *     `undefined` for a foreign app that isn't one of ours.
 *   - `decodeFlagState` reduces a raw flag envelope to the `key × env` row `flag list` prints.
 *   - `renderFlagTable` lays those rows out as a legible table.
 *
 * The env↔app mapping is grounded in the same physical-name scheme `orphan-sweep`'s
 * `FLAGSHIP_APP_NAME_PREFIX`/`decodeStage` decode (`packages/orphan-sweep/src/orphan-sweep.ts`)
 * and in `apps/web/worker/features/flagship/resources.ts` (the app is
 * `Cloudflare.FlagshipApp("phoenix_flags")`, so alchemy names it
 * `${stack}-${id}-${stage}-${suffix}`, `_`→`-` lowercased).
 */

import {Data} from "effect";

const STACK = "phoenix";

/**
 * The Flagship app physical-name prefix. Mirrors `orphan-sweep`'s constant: the app id
 * `phoenix_flags` → `phoenix-flags`, so `${stack}-${id}-` is `phoenix-phoenix-flags-`. A
 * stage lives between this prefix and alchemy's trailing `-<suffix>`.
 */
export const FLAGSHIP_APP_NAME_PREFIX = `${STACK}-${STACK}-flags-`;

/**
 * Decode a Flagship app's physical name back to its stage (the `<stage>` between the
 * prefix and alchemy's last `-<suffix>` segment), or `undefined` when the name is not one
 * of OUR apps — a foreign account app, or a malformed name with no suffix segment. The
 * `undefined` return is the safety hinge every consumer relies on: a name we don't
 * recognize decodes to no env rather than a guessed one.
 */
export const decodeEnv = (appName: string): string | undefined => {
	if (!appName.startsWith(FLAGSHIP_APP_NAME_PREFIX)) {
		return undefined;
	}
	const rest = appName.slice(FLAGSHIP_APP_NAME_PREFIX.length);
	const lastDash = rest.lastIndexOf("-");
	if (lastDash <= 0) {
		return undefined;
	}
	return rest.slice(0, lastDash);
};

/**
 * A Flagship flag reduced to the fields the read decode needs — the slice of
 * `@distilled.cloud/cloudflare`'s `ListAppFlagsResponse`/`GetAppFlagResponse` item this
 * package reads. `variations` maps a variation key to its served value; `defaultVariation`
 * names the variation served when no rule matches or the flag is disabled.
 */
export interface RawFlag {
	readonly key: string;
	readonly enabled: boolean;
	readonly defaultVariation: string;
	readonly variations: Record<string, unknown>;
}

/** One `flag × env` cell: a flag's resolved default state in a single environment. */
export interface FlagState {
	readonly key: string;
	readonly env: string;
	readonly enabled: boolean;
	readonly defaultVariation: string;
	/**
	 * The value `defaultVariation` resolves to (`variations[defaultVariation]`). Per the SDK's
	 * `GetAppFlagResponse` contract this is the value served "when no rule matches OR the flag
	 * is disabled" (a disabled flag bypasses all rules and always serves `defaultVariation`),
	 * so it is the flag's baseline value in this env regardless of `enabled`. `undefined` when
	 * the named variation is absent from `variations` (a malformed flag).
	 */
	readonly defaultValue: unknown;
}

/** Reduce a raw flag envelope in a given env to its `key × env` default-state row. */
export const decodeFlagState = (env: string, flag: RawFlag): FlagState => ({
	key: flag.key,
	env,
	enabled: flag.enabled,
	defaultVariation: flag.defaultVariation,
	defaultValue: flag.variations[flag.defaultVariation],
});

/**
 * No Flagship app serves the requested env — the typed, legible not-found `flag set` fails
 * with BEFORE any read/write, so an unknown `--env` never reaches the mutation. Carries the
 * envs that DO resolve, so the message points the operator at a valid one.
 */
export class FlagEnvNotFound extends Data.TaggedError("FlagEnvNotFound")<{
	readonly env: string;
	readonly knownEnvs: ReadonlyArray<string>;
}> {
	override get message(): string {
		const known = this.knownEnvs.length > 0 ? this.knownEnvs.join(", ") : "(none)";
		return `no Flagship app for env "${this.env}" — known envs: ${known}`;
	}
}

/**
 * No flag with the requested key exists in ANY env — the typed, legible not-found the
 * env-less `flag get <key>` fails with when its per-key slice of `flag list` is empty, so a
 * mistyped key surfaces loud (never a silent empty table). Carries the keys that DO resolve so
 * the message points the operator at a valid one. The `--env`-scoped `flag get` instead fails
 * with the SDK's `FlagshipFlagNotFound` straight off the single-flag read.
 */
export class FlagKeyNotFound extends Data.TaggedError("FlagKeyNotFound")<{
	readonly key: string;
	readonly knownKeys: ReadonlyArray<string>;
}> {
	override get message(): string {
		const known = this.knownKeys.length > 0 ? this.knownKeys.join(", ") : "(none)";
		return `no flag "${this.key}" in any env — known flags: ${known}`;
	}
}

/** The per-key slice of the `flag list` rows — a flag's state in every env it's defined in. */
export const selectStatesForKey = (
	rows: ReadonlyArray<FlagState>,
	key: string,
): ReadonlyArray<FlagState> => rows.filter((r) => r.key === key);

/** Every distinct flag key present across the listed rows, sorted — the `known flags` hint. */
export const distinctKeys = (rows: ReadonlyArray<FlagState>): ReadonlyArray<string> =>
	[...new Set(rows.map((r) => r.key))].sort();

/** The two served states a `flag set` flip targets — the `{off,on}` variation keys. */
export type FlagTarget = "on" | "off";

/**
 * The flip plan `flag set` renders and (with `--execute`) applies: the flag's current served
 * variation and the target one in a single env. `changed` is the safety-legible summary —
 * `false` when the flag already serves the target (an `--execute` is then a confirmed no-op,
 * never a spurious write). This is a pure value; computing it touches no network.
 */
export interface FlipPlan {
	readonly key: string;
	readonly env: string;
	readonly currentVariation: string;
	readonly targetVariation: FlagTarget;
	readonly changed: boolean;
}

/**
 * Compute the `current → target` flip plan for one flag in one env. Pure: it decides only
 * whether the served variation moves, off the flag's current `defaultVariation` and the
 * requested target — the `updateAppFlag` write is a separate integration boundary.
 */
export const computeFlipPlan = (input: {
	readonly key: string;
	readonly env: string;
	readonly currentVariation: string;
	readonly target: FlagTarget;
}): FlipPlan => ({
	key: input.key,
	env: input.env,
	currentVariation: input.currentVariation,
	targetVariation: input.target,
	changed: input.currentVariation !== input.target,
});

/**
 * Find the Flagship app serving a given env, keyed on `decodeEnv` of each app's physical
 * name (a foreign app decodes to no env and is never matched). Generic over `{name}` so the
 * pure core stays free of the read client's `FlagshipApp` type. `undefined` ⇒ no app for that
 * env — the caller fails not-found BEFORE any write.
 */
export const findAppForEnv = <T extends {readonly name: string}>(
	apps: ReadonlyArray<T>,
	env: string,
): T | undefined => apps.find((app) => decodeEnv(app.name) === env);

/**
 * Render the flip plan as a legible one-line `current → target` diff. A no-op flip (already
 * at target) reads as such so a dry-run makes the "nothing to do" case obvious.
 */
export const renderFlipPlan = (plan: FlipPlan): string =>
	plan.changed
		? `flag ${plan.key} @ ${plan.env}: ${plan.currentVariation} → ${plan.targetVariation}`
		: `flag ${plan.key} @ ${plan.env}: already ${plan.targetVariation} (no change)`;

const renderValue = (value: unknown): string => {
	if (typeof value === "string") {
		return value;
	}
	if (value === undefined) {
		return "(none)";
	}
	return JSON.stringify(value);
};

const pad = (cell: string, width: number): string => cell + " ".repeat(width - cell.length);

/**
 * Lay flag rows out as a legible `flag × env` table (key, env, enabled, default value),
 * sorted by key then env so the same flag's envs sit together. Column widths size to the
 * widest cell so the columns line up.
 */
export const renderFlagTable = (rows: ReadonlyArray<FlagState>): string => {
	if (rows.length === 0) {
		return "no flags found";
	}
	const header = ["FLAG", "ENV", "ENABLED", "DEFAULT"] as const;
	const body = [...rows]
		.sort((a, b) => a.key.localeCompare(b.key) || a.env.localeCompare(b.env))
		.map((r): [string, string, string, string] => [
			r.key,
			r.env,
			r.enabled ? "on" : "off",
			renderValue(r.defaultValue),
		]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
	);
	const line = (cells: ReadonlyArray<string>): string =>
		cells
			.map((c, i) => pad(c, widths[i] ?? c.length))
			.join("  ")
			.trimEnd();
	return [line(header), ...body.map(line)].join("\n");
};

/**
 * Render one flag's full state in a single env as a legible key/value block — the
 * `flag get <key> --env <env>` view. Shows the served/default value (the value
 * `defaultVariation` resolves to), `enabled`, and every variation with its value, so the
 * pre-flip confirmation read shows exactly what an env serves and what it could serve.
 */
export const renderFlagDetail = (env: string, flag: RawFlag): string => {
	const served = renderValue(flag.variations[flag.defaultVariation]);
	const label = (l: string) => pad(`${l}:`, 12);
	const variationKeys = Object.keys(flag.variations).sort();
	const variations =
		variationKeys.length > 0
			? variationKeys.map((v) => `  ${v} = ${renderValue(flag.variations[v])}`)
			: ["  (none)"];
	return [
		`${label("flag")}${flag.key}`,
		`${label("env")}${env}`,
		`${label("enabled")}${flag.enabled ? "on" : "off"}`,
		`${label("serves")}${flag.defaultVariation} = ${served}`,
		`${label("variations")}`.trimEnd(),
		...variations,
	].join("\n");
};
