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
