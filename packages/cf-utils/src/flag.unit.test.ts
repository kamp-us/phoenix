/**
 * Pure-core unit tests: the env↔app decode and the flag-state decode, plus the table
 * renderer. No IO, no CF — every case is a deterministic transform.
 */
import {assert, describe, it} from "@effect/vitest";
import {decodeEnv, decodeFlagState, type RawFlag, renderFlagTable} from "./flag.ts";

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
