/**
 * standup/config — the launch-dimension reader (issue #3293), reconciled to the one-role-map seam
 * shape (ADR 0189 / #3236). Covers path resolution, the JSONC strip (comments + trailing commas,
 * string-literal aware), the happy decode against a FULL one-role-map crew config (excess seam keys
 * — bridge role entries, per-role tier/wipCap, operator/notification, and no tmux key — ignored),
 * and — the load-bearing part — fail-closed decoding: each required launch dimension absent or
 * malformed yields a `LaunchConfigError` whose reason names that dimension. The engine count now
 * lives at `roles["engineering-manager"].count`, so its fail-closed cases exercise that path.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	DEFAULT_CONFIG_PATH,
	decodeLaunchConfig,
	LaunchConfigError,
	parseJsonc,
	resolveConfigPath,
	stripJsonc,
} from "./config.ts";

/**
 * A minimal-but-valid launch dimension set in the one-role-map shape: the engine count folds into
 * `roles["engineering-manager"].count`. The allowlist-mode channels carry only
 * `plugin:<name>@<marketplace>` refs — the exact grammar Claude Code 2.1.212's `--channels`
 * allowlist accepts (a bare `server:` ref can't ride `--channels`; #3328).
 */
const validLaunch = {
	cliVersion: "2.1.207",
	roles: {
		"engineering-manager": {count: 2},
	},
	channels: {
		mode: "allowlist",
		servers: ["plugin:crew-channels@pipeline-crew"],
		allowedChannelPlugins: ["pipeline-crew"],
	},
};

/**
 * The launch dimensions never arrive alone — they sit inside the full one-role-map personalization
 * config (ADR 0189): every bridge role entry, each role's `tier`/`wipCap`, the operator +
 * notification + controlPlaneApprover blocks, and — post-#3236 — NO tmux key. All of it is excess
 * to the launch reader, which extracts only cliVersion + the engine count + channels.
 */
const fullCrewConfig = {
	operator: {name: "op", handle: "op"},
	controlPlaneApprover: {name: "cp", login: "cp"},
	notification: {operator: {command: "notify", handle: "op"}},
	...validLaunch,
	roles: {
		"chief-of-staff": {tier: "opus"},
		cartographer: {tier: "fable"},
		"intake-desk": {tier: "fable"},
		"engineering-manager": {tier: "opus", count: 2, wipCap: {productLanes: 1, platformLanes: 1}},
	},
};

const decodeErr = (input: unknown) =>
	Effect.flip(decodeLaunchConfig(input, "/tmp/crew.config.jsonc"));

/** A `validLaunch` variant carrying an arbitrary `roles["engineering-manager"].count` value. */
const withCount = (count: unknown) => ({
	...validLaunch,
	roles: {"engineering-manager": {count}},
});

describe("standup/config — resolveConfigPath", () => {
	it("prefers $CREW_CONFIG when set and non-blank", () => {
		assert.strictEqual(resolveConfigPath({CREW_CONFIG: "/opt/crew.jsonc"}), "/opt/crew.jsonc");
	});
	it("falls back to the default when $CREW_CONFIG is unset or blank", () => {
		assert.strictEqual(resolveConfigPath({}), DEFAULT_CONFIG_PATH);
		assert.strictEqual(resolveConfigPath({CREW_CONFIG: "   "}), DEFAULT_CONFIG_PATH);
	});
});

describe("standup/config — stripJsonc / parseJsonc", () => {
	it("strips line + block comments and trailing commas", () => {
		const jsonc = `{
			// line comment
			"a": 1, /* block */
			"b": [2, 3,],
		}`;
		assert.deepStrictEqual(parseJsonc(jsonc), {a: 1, b: [2, 3]});
	});
	it("preserves comment-like and comma sequences inside string values", () => {
		const jsonc = `{"url": "http://x.y//z", "note": "a, b, c"}`;
		assert.deepStrictEqual(parseJsonc(jsonc), {url: "http://x.y//z", note: "a, b, c"});
	});
	it("does not end a string early on an escaped quote", () => {
		assert.deepStrictEqual(
			stripJsonc(`{"q": "he said \\"hi\\" // ok"}`),
			`{"q": "he said \\"hi\\" // ok"}`,
		);
	});
});

describe("standup/config — decodeLaunchConfig (happy path, one-role-map shape)", () => {
	it.effect(
		"extracts the launch dimensions from a full tmux-free one-role-map config, ignoring excess keys",
		() =>
			Effect.gen(function* () {
				const cfg = yield* decodeLaunchConfig(fullCrewConfig, DEFAULT_CONFIG_PATH);
				assert.strictEqual(cfg.cliVersion, "2.1.207");
				// engine count read off roles["engineering-manager"].count, not a top-level field.
				assert.strictEqual(cfg.engineCount, 2);
				assert.strictEqual(cfg.channels.mode, "allowlist");
				assert.deepStrictEqual([...cfg.channels.servers], ["plugin:crew-channels@pipeline-crew"]);
				assert.deepStrictEqual([...cfg.channels.allowedChannelPlugins], ["pipeline-crew"]);
			}),
	);
	it.effect("accepts the development channel mode carrying a top-level server: ref", () =>
		Effect.gen(function* () {
			// A `server:` ref rides --dangerously-load-development-channels, so it is
			// representable only under development mode — not allowlist (#3328).
			const cfg = yield* decodeLaunchConfig(
				{
					...validLaunch,
					channels: {
						...validLaunch.channels,
						mode: "development",
						servers: ["server:pipeline-crew"],
					},
				},
				DEFAULT_CONFIG_PATH,
			);
			assert.strictEqual(cfg.channels.mode, "development");
			assert.deepStrictEqual([...cfg.channels.servers], ["server:pipeline-crew"]);
		}),
	);
});

describe("standup/config — channel-ref grammar matches Claude Code 2.1.212", () => {
	// The 2.1.212 bundle's --channels tag loop parses a plugin entry as
	// plugin:<name>@<marketplace> (split on @, both parts non-empty); the old
	// plugin:<plugin>:<server> shape (#3293) has no @ and is rejected (#3328).
	it.effect("accepts a plugin:<name>@<marketplace> ref under allowlist", () =>
		Effect.gen(function* () {
			const cfg = yield* decodeLaunchConfig(
				{...validLaunch, channels: {...validLaunch.channels, servers: ["plugin:sozluk@kampus"]}},
				DEFAULT_CONFIG_PATH,
			);
			assert.deepStrictEqual([...cfg.channels.servers], ["plugin:sozluk@kampus"]);
		}),
	);
	it.effect("rejects the old plugin:<plugin>:<server> shape", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {...validLaunch.channels, servers: ["plugin:kampus:sozluk"]},
			});
			assert.include(err.reason, "servers");
		}),
	);
	it.effect("rejects a plugin ref with an empty name or marketplace", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {...validLaunch.channels, servers: ["plugin:@kampus"]},
			});
			assert.include(err.reason, "servers");
		}),
	);
});

describe("standup/config — server: ref reconciles with mode", () => {
	it.effect("rejects a bare server: ref under allowlist mode (runtime skips it)", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {...validLaunch.channels, mode: "allowlist", servers: ["server:pipeline-crew"]},
			});
			assert.include(err.reason, "servers");
		}),
	);
	it.effect("rejects a server: ref mixed among plugin refs under allowlist mode", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {
					...validLaunch.channels,
					mode: "allowlist",
					servers: ["plugin:crew-channels@pipeline-crew", "server:pipeline-crew"],
				},
			});
			assert.include(err.reason, "servers");
		}),
	);
});

describe("standup/config — engine count reads off roles['engineering-manager'].count, fail-closed", () => {
	it.effect("the roles map absent → fails closed naming roles", () =>
		Effect.gen(function* () {
			const {roles: _omit, ...noRoles} = validLaunch;
			const err = yield* decodeErr(noRoles);
			assert.instanceOf(err, LaunchConfigError);
			assert.include(err.reason, "roles");
			assert.strictEqual(err.configPath, "/tmp/crew.config.jsonc");
		}),
	);
	it.effect("the engineering-manager role entry absent → fails closed naming it", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({...validLaunch, roles: {}});
			assert.include(err.reason, "engineering-manager");
		}),
	);
	it.effect("count missing → fails closed naming count", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({...validLaunch, roles: {"engineering-manager": {}}});
			assert.include(err.reason, "count");
		}),
	);
	it.effect("count blank/non-numeric → fails closed naming count", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr(withCount(""));
			assert.include(err.reason, "count");
		}),
	);
	it.effect("count zero → fails closed naming count", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr(withCount(0));
			assert.include(err.reason, "count");
		}),
	);
	it.effect("count negative → fails closed naming count", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr(withCount(-1));
			assert.include(err.reason, "count");
		}),
	);
	it.effect("count non-integer → fails closed naming count", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr(withCount(2.5));
			assert.include(err.reason, "count");
		}),
	);
});

describe("standup/config — fails closed naming the offending dimension", () => {
	it.effect("cliVersion missing", () =>
		Effect.gen(function* () {
			const {cliVersion: _omit, ...rest} = validLaunch;
			const err = yield* decodeErr(rest);
			assert.instanceOf(err, LaunchConfigError);
			assert.include(err.reason, "cliVersion");
			assert.strictEqual(err.configPath, "/tmp/crew.config.jsonc");
		}),
	);
	it.effect("cliVersion malformed (not a version)", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({...validLaunch, cliVersion: "latest"});
			assert.include(err.reason, "cliVersion");
		}),
	);
	it.effect("channels missing", () =>
		Effect.gen(function* () {
			const {channels: _omit, ...rest} = validLaunch;
			const err = yield* decodeErr(rest);
			assert.include(err.reason, "channels");
		}),
	);
	it.effect("channels.mode invalid", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {...validLaunch.channels, mode: "yolo"},
			});
			assert.include(err.reason, "mode");
		}),
	);
	it.effect("channels.servers empty", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {...validLaunch.channels, servers: []},
			});
			assert.include(err.reason, "servers");
		}),
	);
	it.effect("channels.servers holds a malformed ref", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {...validLaunch.channels, servers: ["not-a-valid-ref"]},
			});
			assert.include(err.reason, "servers");
		}),
	);
	it.effect("channels.allowedChannelPlugins missing", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({
				...validLaunch,
				channels: {
					mode: validLaunch.channels.mode,
					servers: validLaunch.channels.servers,
				},
			});
			assert.include(err.reason, "allowedChannelPlugins");
		}),
	);
});
