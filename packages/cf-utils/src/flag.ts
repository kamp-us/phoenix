/**
 * `@kampus/cf-utils` pure core — IO-free, total transforms over already-listed Flagship
 * data. The decodes, the effective-serving computation, the serving-plan model `flag set`
 * dry-runs/applies, and the renderers — so the read/write clients (`flagship.ts`) and bin
 * (`bin.ts`) stay thin and every branch here is unit-testable off-network.
 *
 * The release lever is the **no-match split**, not `defaultVariation` (#1726): real releases
 * are performed as a conditions-empty rule carrying a `rollout: {percentage}` — the wire
 * shape the `@distilled.cloud/cloudflare` Flagship SDK's `GetAppFlagResponse` /
 * `UpdateAppFlagRequest` schemas define (`services/flagship.ts`: `rules[]` of
 * `{conditions, priority, serveVariation, rollout?: {percentage, attribute?}}`). The SDK
 * doc-comment "an empty `rules` array means the flag always serves `default_variation`"
 * does not conflict with a split-released flag showing "zero targeting rules" on the
 * dashboard: the split IS a `rules[]` entry (founder-verified — evaluation reason
 * `100% SPLIT`, changelog "rules → on (100% by targetingKey rollout)"); the dashboard just
 * doesn't count a conditions-empty rollout rule as a targeting rule. `defaultVariation`
 * stays at its create-time safe value forever and is never used as the release lever.
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
 * The slice of a Flagship rule this package reads and round-trips — the SDK's
 * `GetAppFlagResponse`/`UpdateAppFlagRequest` rule shape with `conditions` held opaque
 * (rule-condition edits stay out of scope, #1609): we only test `conditions.length` and pass
 * the entries through verbatim on write.
 */
export interface FlagRule {
	readonly conditions: ReadonlyArray<unknown>;
	readonly priority: number;
	readonly serveVariation: string;
	readonly rollout?: {readonly percentage: number; readonly attribute?: string | null} | null;
}

/**
 * A Flagship flag reduced to the fields this package reads — the slice of
 * `@distilled.cloud/cloudflare`'s `ListAppFlagsResponse`/`GetAppFlagResponse` item.
 * `variations` maps a variation key to its served value; `defaultVariation` names the
 * variation served when no rule matches or the flag is disabled; `rules` carries the
 * serving config — including the no-match split, the actual release lever (#1726).
 */
export interface RawFlag {
	readonly key: string;
	readonly enabled: boolean;
	readonly defaultVariation: string;
	readonly variations: Record<string, unknown>;
	readonly rules: ReadonlyArray<FlagRule>;
}

/**
 * The no-match split: the first (lowest-priority, i.e. evaluated-first) conditions-empty
 * rule carrying a `rollout`. A conditions-empty rule matches everyone; its rollout buckets
 * `percentage`% into `serveVariation` and lets the rest fall through to `defaultVariation`.
 */
export const findNoMatchSplit = (rules: ReadonlyArray<FlagRule>): FlagRule | undefined =>
	[...rules]
		.filter((r) => r.conditions.length === 0 && r.rollout != null)
		.sort((a, b) => a.priority - b.priority)[0];

/**
 * What a flag effectively serves — the answer `flag get`/`flag list` print instead of the
 * lying `defaultVariation` reduction (#1726). `Split` ⇒ the no-match split serves
 * `variation` to `percentage`% (remainder falls to the default); `Default` ⇒ no split, the
 * flag serves `defaultVariation` (also the disabled case — a disabled flag bypasses all
 * rules per the SDK contract). `otherRules` counts the rules that are NOT the resolved
 * split (targeting rules), surfaced as a `+N targeting rules` note.
 */
export type EffectiveServing =
	| {
			readonly _tag: "Split";
			readonly variation: string;
			readonly percentage: number;
			readonly otherRules: number;
	  }
	| {readonly _tag: "Default"; readonly variation: string; readonly otherRules: number};

export const computeEffectiveServing = (flag: RawFlag): EffectiveServing => {
	const split = flag.enabled ? findNoMatchSplit(flag.rules) : undefined;
	const otherRules = flag.rules.filter((r) => r !== split).length;
	if (split?.rollout != null) {
		return {
			_tag: "Split",
			variation: split.serveVariation,
			percentage: split.rollout.percentage,
			otherRules,
		};
	}
	return {_tag: "Default", variation: flag.defaultVariation, otherRules};
};

/**
 * Render effective serving legibly: `on@100% (split)` for a full split release,
 * `on@N% (ramping)` for a partial one, `off (default)` when no split serves, with a
 * `+N targeting rules` suffix when targeting rules exist beyond the split.
 */
export const renderEffectiveServing = (serving: EffectiveServing): string => {
	const base =
		serving._tag === "Split"
			? serving.percentage >= 100
				? `${serving.variation}@100% (split)`
				: `${serving.variation}@${serving.percentage}% (ramping)`
			: `${serving.variation} (default)`;
	return serving.otherRules > 0 ? `${base} +${serving.otherRules} targeting rules` : base;
};

/** One `flag × env` cell: a flag's effective serving state in a single environment. */
export interface FlagState {
	readonly key: string;
	readonly env: string;
	readonly enabled: boolean;
	readonly defaultVariation: string;
	/**
	 * The value `defaultVariation` resolves to (`variations[defaultVariation]`) — the flag's
	 * no-split baseline. `undefined` when the named variation is absent (a malformed flag).
	 */
	readonly defaultValue: unknown;
	readonly serving: EffectiveServing;
}

/** Reduce a raw flag envelope in a given env to its `key × env` effective-serving row. */
export const decodeFlagState = (env: string, flag: RawFlag): FlagState => ({
	key: flag.key,
	env,
	enabled: flag.enabled,
	defaultVariation: flag.defaultVariation,
	defaultValue: flag.variations[flag.defaultVariation],
	serving: computeEffectiveServing(flag),
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

/**
 * `flag set` named neither or both of `on|off` and `--percent N` — the two target forms are
 * mutually exclusive and exactly one is required, enforced with a legible usage error rather
 * than a silent default.
 */
export class FlagSetTargetInvalid extends Data.TaggedError("FlagSetTargetInvalid")<{
	readonly reason: string;
}> {
	override get message(): string {
		return `flag set: ${this.reason} — pass exactly one of "on", "off", or --percent N`;
	}
}

/**
 * The lever guard's refusal — `flag set --execute` (the live-flip write branch ONLY) refused
 * because the humans-release boundary was not satisfied structurally at the lever (ADR 0133,
 * pushing ADR 0083's "agents deploy, humans release" boundary down from the skill to the tool).
 * The `--execute` write is a single-purpose human-release lever with zero legitimate agent
 * callers, so refusing the TTY-less / unconfirmed path costs the legitimate path nothing: a
 * human runs `/release` in a terminal (stdin IS a TTY) and answers the confirm, satisfying the
 * guard by construction — there is deliberately no override flag (a string an agent could pass).
 * The message names the boundary and the recoverable fix, mirroring `ship-it`'s §CP self-merge
 * refusal (ADR 0053) — the same refuse-shape this guard is modeled on.
 */
export class LeverGuardRefused extends Data.TaggedError("LeverGuardRefused")<{
	readonly reason: string;
}> {
	override get message(): string {
		return (
			`flag set --execute refused: ${this.reason}. ` +
			"Flipping a flag live is a human release act — agents deploy, humans release (ADR 0083/0133). " +
			"Run it yourself in an interactive terminal and confirm the prompt; there is no override flag by design."
		);
	}
}

/**
 * The lever guard's decision for the live-flip `--execute` branch. `Allow` ⇒ the human-release
 * boundary is satisfied (an interactive TTY AND an affirmative confirm) and the write proceeds;
 * `Refuse` ⇒ it is not, carrying the `reason` the `LeverGuardRefused` error renders.
 */
export type LeverGuardDecision =
	| {readonly _tag: "Allow"}
	| {readonly _tag: "Refuse"; readonly reason: string};

/**
 * PURE core of the ADR 0133 lever guard — decide whether `flag set --execute` may flip a flag
 * live, given only the two structural inputs the thin IO shell observes: whether stdin is an
 * interactive TTY, and the raw confirm line the operator typed (`undefined` for EOF / no input).
 *
 * Both conditions must hold to `Allow`, and the guard fails toward `Refuse` on any ambiguity —
 * the fail-safe direction ADR 0133 mandates (refusing a TTY-less human is recoverable; letting an
 * agent flip a flag live is not):
 *
 *  - **No TTY ⇒ Refuse** first, before the confirm is even considered — a TTY-less caller is the
 *    exact shape of an autonomous agent or a CI runner. This is the structural refuse: the absence
 *    of a terminal is the signal, no credential/identity check.
 *  - **TTY + confirm ⇒ Allow only on an affirmative** — `y`/`yes` (case-insensitive, whitespace
 *    trimmed). Empty input, EOF (`undefined`), `n`, and anything else ⇒ Refuse. The default is
 *    deny: the human must type a deliberate keystroke.
 */
export const decideLeverGuard = (input: {
	readonly isTTY: boolean;
	readonly confirmResponse: string | undefined;
}): LeverGuardDecision => {
	if (!input.isTTY) {
		return {
			_tag: "Refuse",
			reason: "stdin is not an interactive TTY (this is the shape of an agent or CI runner)",
		};
	}
	const answer = (input.confirmResponse ?? "").trim().toLowerCase();
	if (answer === "y" || answer === "yes") {
		return {_tag: "Allow"};
	}
	return {_tag: "Refuse", reason: "the interactive confirmation was not affirmed (expected y/yes)"};
};

/** The per-key slice of the `flag list` rows — a flag's state in every env it's defined in. */
export const selectStatesForKey = (
	rows: ReadonlyArray<FlagState>,
	key: string,
): ReadonlyArray<FlagState> => rows.filter((r) => r.key === key);

/** Every distinct flag key present across the listed rows, sorted — the `known flags` hint. */
export const distinctKeys = (rows: ReadonlyArray<FlagState>): ReadonlyArray<string> =>
	[...new Set(rows.map((r) => r.key))].sort();

/**
 * What a `flag set` write aims the serving at. `Percent` sets the no-match split so
 * `percentage`% serves `on` and the remainder falls to the (safe, create-time)
 * `defaultVariation` — `flag set <key> on` is `Percent 100`, the canonical fully-on form.
 * `Kill` is the true kill switch: clear the no-match split AND set `defaultVariation` off,
 * so a split-released flag actually stops serving (#1726's sharp finding — a bare
 * `defaultVariation` flip does NOT turn a split-released flag off).
 */
export type ServeTarget =
	| {readonly _tag: "Percent"; readonly percentage: number}
	| {readonly _tag: "Kill"};

export const renderServeTarget = (target: ServeTarget): string =>
	target._tag === "Kill"
		? "off (kill: split cleared, default off)"
		: target.percentage >= 100
			? "on@100% (split)"
			: `on@${target.percentage}% (ramping)`;

/**
 * The next serving state a `ServeTarget` writes: the rules to PUT and the
 * `defaultVariation` to PUT alongside them. `Percent` upserts the no-match split (replacing
 * the existing split in place — preserving its priority and rollout bucketing attribute — or
 * appending one after every existing rule) and leaves `defaultVariation` untouched; `Kill`
 * strips every no-match split rule and moves `defaultVariation` to `off`. Targeting rules
 * pass through verbatim in both (#1609 scope).
 */
export const planNextState = (
	flag: RawFlag,
	target: ServeTarget,
): {readonly defaultVariation: string; readonly rules: ReadonlyArray<FlagRule>} => {
	if (target._tag === "Kill") {
		return {
			defaultVariation: "off",
			rules: flag.rules.filter((r) => !(r.conditions.length === 0 && r.rollout != null)),
		};
	}
	const split = findNoMatchSplit(flag.rules);
	if (split !== undefined) {
		return {
			defaultVariation: flag.defaultVariation,
			rules: flag.rules.map((r) =>
				r === split
					? {
							...r,
							serveVariation: "on",
							rollout: {...(r.rollout ?? {}), percentage: target.percentage},
						}
					: r,
			),
		};
	}
	// No split yet — append one after every existing rule. `rollout.attribute` is omitted: the
	// platform buckets by the OpenFeature targetingKey by default (SDK `GetAppEvaluateRequest`:
	// "Context targeting key … used for percentage rollout bucketing").
	const nextPriority = flag.rules.reduce((max, r) => Math.max(max, r.priority), 0) + 1;
	return {
		defaultVariation: flag.defaultVariation,
		rules: [
			...flag.rules,
			{
				conditions: [],
				priority: nextPriority,
				serveVariation: "on",
				rollout: {percentage: target.percentage},
			},
		],
	};
};

/**
 * The serving plan `flag set` renders and (with `--execute`) applies: the flag's current
 * effective serving and the target in a single env. `changed` is computed off the RAW flag,
 * not the effective serving, so a lurking split rule on a disabled flag still reads as a
 * real kill (`--execute` on an unchanged plan is a confirmed no-op, never a spurious write).
 */
export interface ServingPlan {
	readonly key: string;
	readonly env: string;
	readonly current: EffectiveServing;
	readonly target: ServeTarget;
	readonly changed: boolean;
}

export const computeServingPlan = (input: {
	readonly key: string;
	readonly env: string;
	readonly flag: RawFlag;
	readonly target: ServeTarget;
}): ServingPlan => {
	const split = findNoMatchSplit(input.flag.rules);
	const changed =
		input.target._tag === "Kill"
			? split !== undefined || input.flag.defaultVariation !== "off"
			: split?.serveVariation !== "on" || split?.rollout?.percentage !== input.target.percentage;
	return {
		key: input.key,
		env: input.env,
		current: computeEffectiveServing(input.flag),
		target: input.target,
		changed,
	};
};

/**
 * Render the serving plan as a legible one-line `current → target` diff. A no-op plan
 * (already at target) reads as such so a dry-run makes the "nothing to do" case obvious.
 */
export const renderServingPlan = (plan: ServingPlan): string =>
	plan.changed
		? `flag ${plan.key} @ ${plan.env}: ${renderEffectiveServing(plan.current)} → ${renderServeTarget(plan.target)}`
		: `flag ${plan.key} @ ${plan.env}: already ${renderServeTarget(plan.target)} (no change)`;

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
 * Lay flag rows out as a legible `flag × env` table (key, env, enabled, effective serving),
 * sorted by key then env so the same flag's envs sit together. Column widths size to the
 * widest cell so the columns line up.
 */
export const renderFlagTable = (rows: ReadonlyArray<FlagState>): string => {
	if (rows.length === 0) {
		return "no flags found";
	}
	const header = ["FLAG", "ENV", "ENABLED", "SERVES"] as const;
	const body = [...rows]
		.sort((a, b) => a.key.localeCompare(b.key) || a.env.localeCompare(b.env))
		.map((r): [string, string, string, string] => [
			r.key,
			r.env,
			r.enabled ? "on" : "off",
			renderEffectiveServing(r.serving),
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
 * `flag get <key> --env <env>` view. `serves` is the effective serving (rules → no-match
 * split → default), `default` the no-split baseline, plus every variation with its value —
 * so the pre-release confirmation read shows exactly what an env serves and could serve.
 */
export const renderFlagDetail = (env: string, flag: RawFlag): string => {
	const defaultValue = renderValue(flag.variations[flag.defaultVariation]);
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
		`${label("serves")}${renderEffectiveServing(computeEffectiveServing(flag))}`,
		`${label("default")}${flag.defaultVariation} = ${defaultValue}`,
		`${label("variations")}`.trimEnd(),
		...variations,
	].join("\n");
};
