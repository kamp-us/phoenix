/**
 * standup/orchestrate — the one stand-up command (issue #3299). These tests pin the two properties
 * the composition owns: the MANDATED ORDER (version assert → ensure tracker → derive roster → per-
 * session bind + tmux placement → launch) and FAIL-LOUD WITH NO PARTIAL CREW (every precondition
 * failure aborts, naming its cause, with zero sessions launched). Every side-effecting step is
 * injected — a version reader, a recording tracker, a recording launcher — so the whole boot runs in
 * a unit test with no real subprocess, tmux, or `claude`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Schema} from "effect";
import {CREW_ROLES, kindOf} from "../crew/index.ts";
import {CREW_SESSION_INSTANCE_FLAG} from "./bind.ts";
import {LaunchConfig, LaunchConfigError} from "./config.ts";
import {type TrackerHandle, TrackerNotServingError} from "./ensure-tracker.ts";
import {
	CliVersionAssertError,
	CrewServerNotRegisteredError,
	type LaunchedSession,
	type LaunchPlan,
	runStandUp,
	type StandUpInput,
	TmuxWindowUnnamedError,
} from "./index.ts";

const PINNED = "2.1.212";
const SERVER = "@kampus/pipeline-crew-mcp";

/** A dev-mode config carrying the crew's own `server:` ref — the shape bind + config both accept. */
const configAt = (cliVersion: string, engineCount: number): LaunchConfig =>
	Schema.decodeUnknownSync(LaunchConfig)({
		cliVersion,
		engineCount,
		channels: {mode: "development", servers: [`server:${SERVER}`], allowedChannelPlugins: []},
	});

/** Operator tmux naming: a window per bridge role, keyed by the role slug (engines self-name by id). */
const tmuxNaming = {
	session: "crew",
	windows: {
		"chief-of-staff": "cos",
		cartographer: "carto",
		"intake-desk": "intake",
	},
};

/** A deterministic engine instance-id generator so the derived set + windows are pinnable. */
const counter = () => {
	let i = 0;
	return () => `e${i++}`;
};

/** A recording launcher: never touches tmux, just captures the plans it was handed in call order. */
const recordingLauncher = () => {
	const plans: LaunchPlan[] = [];
	const launch = (plan: LaunchPlan): Effect.Effect<LaunchedSession, never> => {
		plans.push(plan);
		return Effect.succeed({
			role: plan.session.role,
			address: plan.session.address,
			window: plan.placement.window,
			pid: 1000 + plans.length,
		});
	};
	return {plans, launch};
};

const trackerHandle: TrackerHandle = {pid: 4242, socketPath: "/tmp/crew.sock"};

/** A recording tracker-ensurer: counts calls so "was the tracker reached before the abort?" is checkable. */
const recordingTracker = (
	result: Effect.Effect<TrackerHandle, TrackerNotServingError> = Effect.succeed(trackerHandle),
) => {
	let calls = 0;
	const ensureTracker = (_projectRoot: string) => {
		calls++;
		return result;
	};
	return {ensureTracker, calls: () => calls};
};

/** The full happy-path input with every side effect injected — a stand-up that never leaves the process. */
const baseInput = (
	overrides: Partial<StandUpInput> & {engineCount?: number} = {},
): {input: StandUpInput; launched: LaunchPlan[]; trackerCalls: () => number} => {
	const {plans, launch} = recordingLauncher();
	const {ensureTracker, calls} = recordingTracker();
	const {engineCount, ...rest} = overrides;
	return {
		launched: plans,
		trackerCalls: calls,
		input: {
			projectRoot: "/repo",
			tmuxConfig: Effect.succeed(tmuxNaming),
			config: Effect.succeed(configAt(PINNED, engineCount ?? 2)),
			readVersionOutput: Effect.succeed(`${PINNED} (Claude Code)`),
			instanceId: counter(),
			ensureTracker,
			launch,
			...rest,
		},
	};
};

const bridgeRoles = CREW_ROLES.filter((r) => kindOf(r) === "bridge");

describe("standup/orchestrate — the one stand-up command (issue #3299)", () => {
	it.effect(
		"stands up tracker + one window per bridge + N engine sessions, in roster order (AC1,AC2)",
		() =>
			Effect.gen(function* () {
				const N = 3;
				const {input, launched, trackerCalls} = baseInput({engineCount: N});
				const result = yield* runStandUp(input);

				assert.strictEqual(trackerCalls(), 1);
				assert.strictEqual(result.tracker, trackerHandle);
				// one launch per bridge + N engines, and the result mirrors the launched set.
				assert.strictEqual(launched.length, bridgeRoles.length + N);
				assert.strictEqual(result.launched.length, launched.length);

				const launchedBridges = launched.filter((p) => p.session.kind === "bridge");
				const launchedEngines = launched.filter((p) => p.session.kind === "engine");
				assert.strictEqual(launchedBridges.length, bridgeRoles.length);
				assert.strictEqual(launchedEngines.length, N);
				// each session is launched bound to its role lease (the session-set address) — no hand-launch.
				for (const p of launched) {
					assert.strictEqual(p.bind.role, p.session.role);
					assert.match(p.session.address, /^inbox:\/\//);
				}
				// bridges placed on their operator-named windows, engines on their generated instance ids.
				const cos = launchedBridges.find((p) => p.session.role === "chief-of-staff");
				assert.strictEqual(cos?.placement.window, "cos");
				assert.deepStrictEqual(launchedEngines.map((p) => p.placement.window).sort(), [
					"e0",
					"e1",
					"e2",
				]);
			}),
	);

	it.effect("scales the engine pool with the config engine count (AC2)", () =>
		Effect.gen(function* () {
			for (const N of [1, 4]) {
				const {input, launched} = baseInput({engineCount: N, instanceId: counter()});
				yield* runStandUp(input);
				assert.strictEqual(launched.filter((p) => p.session.kind === "engine").length, N);
				assert.strictEqual(
					launched.filter((p) => p.session.kind === "bridge").length,
					bridgeRoles.length,
				);
			}
		}),
	);

	it.effect(
		"aborts on a CLI version drift BEFORE the tracker or any launch (AC3, fail-loud order)",
		() =>
			Effect.gen(function* () {
				const {input, launched, trackerCalls} = baseInput({
					readVersionOutput: Effect.succeed("2.1.300 (Claude Code)"),
				});
				const err = yield* Effect.flip(runStandUp(input));

				assert.instanceOf(err, CliVersionAssertError);
				// version assert runs before ensure-tracker: the tracker was never reached, nothing launched.
				assert.strictEqual(trackerCalls(), 0);
				assert.strictEqual(launched.length, 0);
			}),
	);

	it.effect("aborts on an unreadable operator config before any side effect (AC3)", () =>
		Effect.gen(function* () {
			const {input, launched, trackerCalls} = baseInput({
				config: Effect.fail(
					new LaunchConfigError({configPath: ".claude/crew.config.jsonc", reason: "missing"}),
				),
			});
			const err = yield* Effect.flip(runStandUp(input));

			assert.instanceOf(err, LaunchConfigError);
			assert.strictEqual(trackerCalls(), 0);
			assert.strictEqual(launched.length, 0);
		}),
	);

	it.effect("aborts when the tracker cannot be brought up, before any session launches (AC3)", () =>
		Effect.gen(function* () {
			const {input, launched} = baseInput({
				ensureTracker: (_root: string) =>
					Effect.fail(new TrackerNotServingError({socketPath: "/tmp/crew.sock"})),
			});
			const err = yield* Effect.flip(runStandUp(input));

			assert.instanceOf(err, TrackerNotServingError);
			// derive/bind/placement/launch all sit after ensure-tracker — nothing launched.
			assert.strictEqual(launched.length, 0);
		}),
	);

	it.effect("aborts when a bridge names no operator tmux window — no partial crew (AC3)", () =>
		Effect.gen(function* () {
			const {input, launched} = baseInput({
				// cartographer/intake-desk unnamed
				tmuxConfig: Effect.succeed({session: "crew", windows: {"chief-of-staff": "cos"}}),
			});
			const err = yield* Effect.flip(runStandUp(input));

			assert.instanceOf(err, TmuxWindowUnnamedError);
			// placement is resolved for the WHOLE set before the first launch — a single unnamed window
			// aborts stand-up with zero sessions up (the no-partial-crew line).
			assert.strictEqual(launched.length, 0);
		}),
	);

	it.effect(
		"aborts when the crew server would be inert (unregistered channel), before any launch (AC3)",
		() =>
			Effect.gen(function* () {
				const {input, launched} = baseInput({serverName: "not-in-servers"});
				const err = yield* Effect.flip(runStandUp(input));

				assert.instanceOf(err, CrewServerNotRegisteredError);
				assert.strictEqual(launched.length, 0);
			}),
	);

	it.effect(
		"reads tmux naming from config: a malformed tmux dimension aborts before launch (seam 1)",
		() =>
			Effect.gen(function* () {
				const {input, launched, trackerCalls} = baseInput({
					tmuxConfig: Effect.fail(
						new LaunchConfigError({configPath: ".claude/crew.config.jsonc", reason: "tmux"}),
					),
				});
				const err = yield* Effect.flip(runStandUp(input));

				assert.instanceOf(err, LaunchConfigError);
				// tmux is read alongside the launch config, before the tracker or any launch.
				assert.strictEqual(trackerCalls(), 0);
				assert.strictEqual(launched.length, 0);
			}),
	);

	it.effect("threads each engine's per-instance identity into its launch argv (seam 3)", () =>
		Effect.gen(function* () {
			const {input, launched} = baseInput({engineCount: 3});
			yield* runStandUp(input);

			const engines = launched.filter((p) => p.session.kind === "engine");
			assert.strictEqual(engines.length, 3);
			for (const p of engines) {
				assert.strictEqual(p.session.kind, "engine");
				const instance = p.session.kind === "engine" ? p.session.instance : "";
				// the instance-flag pair rides the inline --mcp-config JSON (mcpConfigArg[1]).
				const mcpJson = p.bind.mcpConfigArg[1];
				assert.include(mcpJson, `"${CREW_SESSION_INSTANCE_FLAG}"`);
				assert.include(mcpJson, `"${instance}"`);
			}
			// a bridge is a singleton and carries no --instance in its argv.
			const bridge = launched.find((p) => p.session.kind === "bridge");
			assert.notInclude(bridge?.bind.mcpConfigArg[1] ?? "", CREW_SESSION_INSTANCE_FLAG);
		}),
	);
});
