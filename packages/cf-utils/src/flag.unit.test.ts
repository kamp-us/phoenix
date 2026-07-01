/**
 * Pure-core unit tests: the env↔app decode and the flag-state decode, plus the table
 * renderer. No IO, no CF — every case is a deterministic transform.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	computeFlipPlan,
	decodeEnv,
	decodeFlagState,
	distinctKeys,
	FlagEnvNotFound,
	FlagKeyNotFound,
	findAppForEnv,
	type RawFlag,
	renderFlagDetail,
	renderFlagTable,
	renderFlipPlan,
	selectStatesForKey,
} from "./flag.ts";

describe("decodeEnv — Flagship app physical name → env", () => {
	it("decodes the prod app", () => {
		assert.strictEqual(decodeEnv("phoenix-phoenix-flags-prod-abc123"), "prod");
	});

	it("decodes a non-prod (preview) stage", () => {
		assert.strictEqual(decodeEnv("phoenix-phoenix-flags-pr-42-deadbe"), "pr-42");
	});

	it("returns undefined for a foreign / unrecognized app name", () => {
		assert.strictEqual(decodeEnv("some-other-account-app"), undefined);
	});

	it("returns undefined for a name with the prefix but no suffix segment", () => {
		assert.strictEqual(decodeEnv("phoenix-phoenix-flags-prod"), undefined);
	});
});

const flag = (over: Partial<RawFlag> = {}): RawFlag => ({
	key: "new-nav",
	enabled: true,
	defaultVariation: "on",
	variations: {on: true, off: false},
	...over,
});

describe("decodeFlagState — resolve a flag's default value in an env", () => {
	it("resolves the defaultVariation to its value", () => {
		const state = decodeFlagState("prod", flag());
		assert.deepStrictEqual(state, {
			key: "new-nav",
			env: "prod",
			enabled: true,
			defaultVariation: "on",
			defaultValue: true,
		});
	});

	it("still resolves the default value for a DISABLED flag (it bypasses rules, serves defaultVariation)", () => {
		const state = decodeFlagState("pr-7", flag({enabled: false, defaultVariation: "off"}));
		assert.strictEqual(state.enabled, false);
		assert.strictEqual(state.defaultValue, false);
	});

	it("resolves a string-typed variation value", () => {
		const state = decodeFlagState(
			"prod",
			flag({defaultVariation: "green", variations: {green: "#0f0"}}),
		);
		assert.strictEqual(state.defaultValue, "#0f0");
	});

	it("yields undefined when the named variation is absent (a malformed flag)", () => {
		const state = decodeFlagState(
			"prod",
			flag({defaultVariation: "ghost", variations: {on: true}}),
		);
		assert.strictEqual(state.defaultValue, undefined);
	});
});

describe("computeFlipPlan — current → target flip (pure)", () => {
	it("marks a real flip as changed", () => {
		const plan = computeFlipPlan({
			key: "authorship-loop",
			env: "prod",
			currentVariation: "off",
			target: "on",
		});
		assert.deepStrictEqual(plan, {
			key: "authorship-loop",
			env: "prod",
			currentVariation: "off",
			targetVariation: "on",
			changed: true,
		});
	});

	it("marks a no-op flip (already at target) as unchanged — the confirmed --execute no-op", () => {
		const plan = computeFlipPlan({key: "beta", env: "prod", currentVariation: "on", target: "on"});
		assert.strictEqual(plan.changed, false);
	});
});

describe("renderFlipPlan", () => {
	it("renders a real flip as a current → target diff", () => {
		const line = renderFlipPlan(
			computeFlipPlan({key: "authorship-loop", env: "prod", currentVariation: "off", target: "on"}),
		);
		assert.match(line, /authorship-loop @ prod: off → on/);
	});

	it("renders a no-op flip as 'already <target> (no change)'", () => {
		const line = renderFlipPlan(
			computeFlipPlan({key: "beta", env: "prod", currentVariation: "on", target: "on"}),
		);
		assert.match(line, /already on \(no change\)/);
	});
});

describe("findAppForEnv — resolve the Flagship app serving an env", () => {
	const apps = [
		{id: "app-prod", name: "phoenix-phoenix-flags-prod-abc123"},
		{id: "app-pr9", name: "phoenix-phoenix-flags-pr-9-deadbe"},
		{id: "app-foreign", name: "some-other-account-app"},
	];

	it("finds the app whose decoded env matches", () => {
		assert.strictEqual(findAppForEnv(apps, "prod")?.id, "app-prod");
		assert.strictEqual(findAppForEnv(apps, "pr-9")?.id, "app-pr9");
	});

	it("returns undefined for an env no app serves (and never matches a foreign app)", () => {
		assert.isUndefined(findAppForEnv(apps, "staging"));
	});
});

describe("FlagEnvNotFound — the typed, legible not-found", () => {
	it("names the unknown env and lists the known ones", () => {
		const err = new FlagEnvNotFound({env: "staging", knownEnvs: ["prod", "pr-9"]});
		assert.match(err.message, /staging/);
		assert.match(err.message, /prod, pr-9/);
	});
});

describe("selectStatesForKey — the per-key slice of flag list", () => {
	const rows = [
		decodeFlagState("prod", flag({key: "new-nav"})),
		decodeFlagState("pr-9", flag({key: "new-nav"})),
		decodeFlagState("prod", flag({key: "beta-banner", enabled: false, defaultVariation: "off"})),
	];

	it("keeps only the rows for the named key, across every env", () => {
		const slice = selectStatesForKey(rows, "new-nav");
		assert.strictEqual(slice.length, 2);
		assert.deepStrictEqual(slice.map((r) => r.env).sort(), ["pr-9", "prod"]);
	});

	it("returns an empty slice for a key present in no env (the not-found trigger)", () => {
		assert.strictEqual(selectStatesForKey(rows, "ghost").length, 0);
	});
});

describe("distinctKeys — the known-flags hint", () => {
	it("lists each distinct key once, sorted", () => {
		const rows = [
			decodeFlagState("prod", flag({key: "new-nav"})),
			decodeFlagState("pr-9", flag({key: "new-nav"})),
			decodeFlagState("prod", flag({key: "beta-banner"})),
		];
		assert.deepStrictEqual(distinctKeys(rows), ["beta-banner", "new-nav"]);
	});

	it("is empty for no rows", () => {
		assert.deepStrictEqual(distinctKeys([]), []);
	});
});

describe("FlagKeyNotFound — the typed, legible env-less not-found", () => {
	it("names the unknown key and lists the known ones", () => {
		const err = new FlagKeyNotFound({key: "ghost", knownKeys: ["new-nav", "beta-banner"]});
		assert.match(err.message, /ghost/);
		assert.match(err.message, /new-nav, beta-banner/);
	});

	it("renders (none) when no flags exist at all", () => {
		const err = new FlagKeyNotFound({key: "ghost", knownKeys: []});
		assert.match(err.message, /\(none\)/);
	});
});

describe("renderFlagDetail — the single-flag --env view", () => {
	it("shows key, env, enabled, served default value, and every variation", () => {
		const detail = renderFlagDetail(
			"prod",
			flag({
				key: "authorship-loop",
				enabled: true,
				defaultVariation: "off",
				variations: {off: false, on: true},
			}),
		);
		assert.match(detail, /flag:\s+authorship-loop/);
		assert.match(detail, /env:\s+prod/);
		assert.match(detail, /enabled:\s+on/);
		// the served value is the variation's resolved value, not just its name
		assert.match(detail, /serves:\s+off = false/);
		assert.match(detail, /off = false/);
		assert.match(detail, /on = true/);
	});

	it("renders enabled:off for a disabled flag (its default value still resolves)", () => {
		const detail = renderFlagDetail(
			"pr-7",
			flag({enabled: false, defaultVariation: "off", variations: {off: false, on: true}}),
		);
		assert.match(detail, /enabled:\s+off/);
		assert.match(detail, /serves:\s+off = false/);
	});

	it("shows (none) for the served value when the variation is absent (a malformed flag)", () => {
		const detail = renderFlagDetail(
			"prod",
			flag({defaultVariation: "ghost", variations: {on: true}}),
		);
		assert.match(detail, /serves:\s+ghost = \(none\)/);
	});
});

describe("renderFlagTable", () => {
	it("reports the empty case", () => {
		assert.strictEqual(renderFlagTable([]), "no flags found");
	});

	it("renders a legible header + one row per flag×env, sorted by key then env", () => {
		const table = renderFlagTable([
			decodeFlagState("prod", flag({key: "beta", enabled: false, defaultVariation: "off"})),
			decodeFlagState("pr-1", flag({key: "alpha"})),
		]);
		const lines = table.split("\n");
		assert.match(lines[0] ?? "", /FLAG\s+ENV\s+ENABLED\s+DEFAULT/);
		// alpha sorts before beta
		assert.match(lines[1] ?? "", /^alpha\s+pr-1\s+on\s+true/);
		assert.match(lines[2] ?? "", /^beta\s+prod\s+off\s+false/);
	});
});
