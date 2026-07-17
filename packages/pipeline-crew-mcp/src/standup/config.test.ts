/**
 * standup/config — the launch-dimension reader (issue #3293). Covers path resolution, the
 * JSONC strip (comments + trailing commas, string-literal aware), the happy decode against a
 * FULL crew config (excess seam keys ignored), and — the load-bearing part — fail-closed
 * decoding: each required launch dimension absent or malformed yields a `LaunchConfigError`
 * whose reason names that dimension.
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

/** A minimal-but-valid launch dimension set, embedded in a fuller crew config below. */
const validLaunch = {
	cliVersion: "2.1.207",
	engineCount: 2,
	channels: {
		mode: "allowlist",
		servers: ["server:crew-channels", "plugin:pipeline-crew:crew-channels"],
		allowedChannelPlugins: ["pipeline-crew"],
	},
};

/** The launch dimensions never arrive alone — they sit inside the full personalization config. */
const fullCrewConfig = {
	operator: {name: "op", handle: "op"},
	tmux: {session: "s", windows: {ea: "ea", engineeringManager: "em", triage: "t"}},
	...validLaunch,
};

const decodeErr = (input: unknown) =>
	Effect.flip(decodeLaunchConfig(input, "/tmp/crew.config.jsonc"));

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

describe("standup/config — decodeLaunchConfig (happy path)", () => {
	it.effect("extracts the launch dimensions from a full crew config, ignoring excess keys", () =>
		Effect.gen(function* () {
			const cfg = yield* decodeLaunchConfig(fullCrewConfig, DEFAULT_CONFIG_PATH);
			assert.strictEqual(cfg.cliVersion, "2.1.207");
			assert.strictEqual(cfg.engineCount, 2);
			assert.strictEqual(cfg.channels.mode, "allowlist");
			assert.deepStrictEqual(
				[...cfg.channels.servers],
				["server:crew-channels", "plugin:pipeline-crew:crew-channels"],
			);
			assert.deepStrictEqual([...cfg.channels.allowedChannelPlugins], ["pipeline-crew"]);
		}),
	);
	it.effect("accepts the development channel mode", () =>
		Effect.gen(function* () {
			const cfg = yield* decodeLaunchConfig(
				{...validLaunch, channels: {...validLaunch.channels, mode: "development"}},
				DEFAULT_CONFIG_PATH,
			);
			assert.strictEqual(cfg.channels.mode, "development");
		}),
	);
});

describe("standup/config — fails closed naming the offending dimension", () => {
	const without = (key: keyof typeof validLaunch) => {
		const {[key]: _omit, ...rest} = validLaunch;
		return rest;
	};

	it.effect("cliVersion missing", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr(without("cliVersion"));
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
	it.effect("engineCount missing", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr(without("engineCount"));
			assert.include(err.reason, "engineCount");
		}),
	);
	it.effect("engineCount below one", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({...validLaunch, engineCount: 0});
			assert.include(err.reason, "engineCount");
		}),
	);
	it.effect("engineCount non-integer", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr({...validLaunch, engineCount: 2.5});
			assert.include(err.reason, "engineCount");
		}),
	);
	it.effect("channels missing", () =>
		Effect.gen(function* () {
			const err = yield* decodeErr(without("channels"));
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
