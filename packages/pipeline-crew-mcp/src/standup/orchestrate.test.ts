/**
 * standup/orchestrate — the one stand-up command (issue #3299), booting against the post-#3236
 * one-role-map config (ADR 0189): the engine count folds into `roles["engineering-manager"].count`
 * and there is NO config tmux dimension — pane placement derives from role identity at launch.
 * These tests pin the two properties the composition owns: the MANDATED ORDER (version assert →
 * ensure tracker → derive roster → per-session bind + tmux placement → launch) and FAIL-LOUD WITH NO
 * PARTIAL CREW (every precondition failure aborts, naming its cause, with zero sessions launched).
 * Every side-effecting step is injected — a version reader, a recording tracker, a recording launcher
 * — so the whole boot runs in a unit test with no real subprocess, tmux, or `claude`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {CREW_ROLES, kindOf} from "../crew/index.ts";
import {CREW_SESSION_INSTANCE_FLAG} from "./bind.ts";
import {
	DEFAULT_CONFIG_PATH,
	decodeLaunchConfig,
	type LaunchConfig,
	LaunchConfigError,
} from "./config.ts";
import {type TrackerHandle, TrackerNotServingError} from "./ensure-tracker.ts";
import {
	CliVersionAssertError,
	CREW_WINDOW,
	CrewServerNotRegisteredError,
	ensureNamedTmuxSession,
	FALLBACK_TMUX_SESSION,
	type LaunchedSession,
	type LaunchPlan,
	launchSessionInTmux,
	renderStandUpError,
	resolveTargetTmuxSession,
	runStandUp,
	type StandUpInput,
	StandUpLaunchError,
	type TmuxRun,
	type TmuxRunner,
	TmuxSessionEnsureError,
} from "./index.ts";

const PINNED = "2.1.212";
const SERVER = "@kampus/pipeline-crew-mcp";

/**
 * A post-#3236 one-role-map crew config (raw, on-disk shape): the engine count lives at
 * `roles["engineering-manager"].count`; bridge entries + per-role tier/wipCap are excess seam keys;
 * there is NO tmux key. Decoded through `decodeLaunchConfig` so the boot exercises the real
 * new-template decode end to end (the dogfood: stand up from a config regenerated from the template).
 */
const rawConfigAt = (cliVersion: string, engineCount: number): unknown => ({
	cliVersion,
	roles: {
		"chief-of-staff": {tier: "opus"},
		cartographer: {tier: "fable"},
		"intake-desk": {tier: "fable"},
		"engineering-manager": {
			tier: "opus",
			count: engineCount,
			wipCap: {productLanes: 1, platformLanes: 1},
		},
	},
	// dev mode carries the crew's own `server:` ref — the shape bind + config both accept.
	channels: {mode: "development", servers: [`server:${SERVER}`], allowedChannelPlugins: []},
});

const configAt = (
	cliVersion: string,
	engineCount: number,
): Effect.Effect<LaunchConfig, LaunchConfigError> =>
	decodeLaunchConfig(rawConfigAt(cliVersion, engineCount), DEFAULT_CONFIG_PATH);

/** A deterministic engine instance-id generator so the derived set + windows are pinnable. */
const counter = () => {
	let i = 0;
	return () => `e${i++}`;
};

const RESOLVED_SESSION = "operator-session";

/** The window id the recording launcher's first pane "opens" — threaded into every later pane's `intoWindow`. */
const RECORDED_CREW_WINDOW = "@crew";

/**
 * A recording launcher + target-session resolver sharing one `order` log, so a test can prove the target
 * session is resolved BEFORE any pane is placed and that every pane opens into THAT session (founder ruling
 * #3418: the caller's current session, not a hardcoded one). It also records each launch's `intoWindow`, so a
 * test can prove the FIRST session opens the crew window (`intoWindow` undefined) and every later one splits into
 * the window id the first returned (founder ruling #3424). Neither touches tmux: the launcher captures its plans,
 * the session it was told to open into, and its `intoWindow`; the resolver captures its calls and returns `RESOLVED_SESSION`.
 */
const recordingLauncher = () => {
	const plans: LaunchPlan[] = [];
	const order: string[] = [];
	const targetSessions: string[] = [];
	const intoWindows: (string | undefined)[] = [];
	const resolveCalls = {n: 0};
	const launch = (
		plan: LaunchPlan,
		targetSession: string,
		intoWindow: string | undefined,
	): Effect.Effect<LaunchedSession, never> => {
		plans.push(plan);
		targetSessions.push(targetSession);
		intoWindows.push(intoWindow);
		order.push(`launch:${plan.placement.paneLabel}`);
		return Effect.succeed({
			role: plan.session.role,
			address: plan.session.address,
			// the first pane opens the crew window and returns its id; every later pane rides the threaded id.
			window: intoWindow ?? RECORDED_CREW_WINDOW,
			pane: plan.placement.paneLabel,
			pid: 1000 + plans.length,
		});
	};
	const resolveTargetSession = (): Effect.Effect<string, never> => {
		resolveCalls.n++;
		order.push("resolve");
		return Effect.succeed(RESOLVED_SESSION);
	};
	return {plans, order, targetSessions, intoWindows, resolveCalls, launch, resolveTargetSession};
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
): {
	input: StandUpInput;
	launched: LaunchPlan[];
	order: string[];
	targetSessions: string[];
	intoWindows: (string | undefined)[];
	resolveCalls: {n: number};
	trackerCalls: () => number;
} => {
	const {plans, order, targetSessions, intoWindows, resolveCalls, launch, resolveTargetSession} =
		recordingLauncher();
	const {ensureTracker, calls} = recordingTracker();
	const {engineCount, ...rest} = overrides;
	return {
		launched: plans,
		order,
		targetSessions,
		intoWindows,
		resolveCalls,
		trackerCalls: calls,
		input: {
			projectRoot: "/repo",
			config: configAt(PINNED, engineCount ?? 2),
			readVersionOutput: Effect.succeed(`${PINNED} (Claude Code)`),
			instanceId: counter(),
			ensureTracker,
			resolveTargetSession,
			launch,
			...rest,
		},
	};
};

/** A recording tmux runner: replays a scripted `TmuxRun` per invocation so `launchSessionInTmux` /
 * `resolveTargetTmuxSession` run their exit-code branches with no real tmux — the async-exit seam #3418 closed. */
const scriptedTmux = (runs: readonly TmuxRun[]): {runner: TmuxRunner; argvLog: string[][]} => {
	const argvLog: string[][] = [];
	let i = 0;
	const runner: TmuxRunner = (args) => {
		argvLog.push([...args]);
		const run = runs[Math.min(i, runs.length - 1)];
		i++;
		return run === undefined ? Effect.die("scriptedTmux: no run scripted") : Effect.succeed(run);
	};
	return {runner, argvLog};
};

const exited = (code: number | null, over: Partial<TmuxRun> = {}): TmuxRun => ({
	pid: code === 0 ? 4242 : undefined,
	code,
	signal: null,
	stdout: "",
	spawnError: undefined,
	...over,
});

const bridgeRoles = CREW_ROLES.filter((r) => kindOf(r) === "bridge");

describe("standup/orchestrate — the one stand-up command (issue #3299)", () => {
	it.effect(
		"stands up tracker + one pane per bridge + N engine panes, in roster order (AC1,AC2)",
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
				// bridges labelled by their role slug, engines by their generated ids.
				const cos = launchedBridges.find((p) => p.session.role === "chief-of-staff");
				assert.strictEqual(cos?.placement.paneLabel, "chief-of-staff");
				assert.deepStrictEqual(launchedEngines.map((p) => p.placement.paneLabel).sort(), [
					"e0",
					"e1",
					"e2",
				]);
			}),
	);

	it.effect(
		"launches the crew as PANES of ONE window: first opens it, every later pane splits into that id (#3424 AC1,AC2)",
		() =>
			Effect.gen(function* () {
				const {input, intoWindows, launched} = baseInput({engineCount: 2});
				const result = yield* runStandUp(input);

				// exactly one session opens the crew window (intoWindow undefined); every later one splits into it.
				assert.strictEqual(intoWindows.length, launched.length);
				assert.strictEqual(intoWindows[0], undefined, "the first session opens the crew window");
				for (const w of intoWindows.slice(1)) {
					assert.strictEqual(
						w,
						RECORDED_CREW_WINDOW,
						"every later pane splits into the opened window id",
					);
				}
				// every launched session reports the one shared crew window.
				for (const s of result.launched) assert.strictEqual(s.window, RECORDED_CREW_WINDOW);
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

	it.effect("threads each role's config tier into its launch --model (#3423, end to end)", () =>
		Effect.gen(function* () {
			// rawConfigAt sets the founder ruling — cartographer=fable, the rest=opus — so the boot
			// proves each session comes up on its configured tier's model, not the CLI default.
			const {input, launched} = baseInput({engineCount: 2});
			yield* runStandUp(input);

			const modelOf = (role: string): readonly string[] | undefined =>
				launched.find((p) => p.session.role === role)?.bind.modelArg;
			assert.deepStrictEqual([...(modelOf("chief-of-staff") ?? [])], ["--model", "opus"]);
			assert.deepStrictEqual([...(modelOf("cartographer") ?? [])], ["--model", "fable"]);
			assert.deepStrictEqual([...(modelOf("intake-desk") ?? [])], ["--model", "fable"]);
			// every engine boots on the engineering-manager tier (opus).
			for (const p of launched.filter((x) => x.session.kind === "engine")) {
				assert.deepStrictEqual([...p.bind.modelArg], ["--model", "opus"]);
				// --model leads the argv, ahead of the #3425 mcp-config fragment.
				assert.strictEqual(p.bind.argv[0], "--model");
			}
		}),
	);

	it.effect(
		"resolves the target session BEFORE placing any pane, and opens every pane into it (#3418 AC1)",
		() =>
			Effect.gen(function* () {
				const {input, order, targetSessions} = baseInput({engineCount: 2});
				yield* runStandUp(input);

				// the target session is resolved before any launch, and every pane is opened into it.
				const firstLaunch = order.findIndex((e) => e.startsWith("launch:"));
				const lastResolve = order.lastIndexOf("resolve");
				assert.isBelow(lastResolve, firstLaunch);
				assert.isAbove(targetSessions.length, 0);
				for (const s of targetSessions) assert.strictEqual(s, RESOLVED_SESSION);
			}),
	);

	it.effect(
		"aborts fail-loud when the target session cannot be resolved (outside-tmux fallback create fails) (#3418 AC3)",
		() =>
			Effect.gen(function* () {
				const {input, launched} = baseInput({
					resolveTargetSession: () =>
						Effect.fail(
							new TmuxSessionEnsureError({session: "crew", reason: "new-session exited 1"}),
						),
				});
				const err = yield* Effect.flip(runStandUp(input));

				assert.instanceOf(err, TmuxSessionEnsureError);
				// session resolution sits before the launch loop — nothing launched when it fails.
				assert.strictEqual(launched.length, 0);
			}),
	);

	it.effect(
		"reports no launch count for a session that never started — a failed launch fails loud (#3418 AC4)",
		() =>
			Effect.gen(function* () {
				const {input} = baseInput({
					engineCount: 1,
					launch: (plan, _targetSession, _intoWindow) =>
						Effect.fail(
							new StandUpLaunchError({
								role: plan.session.role,
								pane: plan.placement.paneLabel,
								reason: "tmux new-window exited 1 (no live pane)",
							}),
						),
				});
				const err = yield* Effect.flip(runStandUp(input));
				assert.instanceOf(err, StandUpLaunchError);
			}),
	);
});

/**
 * The real launcher primitives against a scripted tmux runner — the async-exit path #3418 closed: a
 * non-zero exit is inspected and fails closed, not counted as success. No real tmux, no `claude`.
 */
describe("standup/orchestrate — launch-liveness + ensure-session (issue #3418)", () => {
	// Capture one real, fully-derived LaunchPlan by running a stand-up whose launcher just records it.
	const captureOnePlan = Effect.gen(function* () {
		const {input, launched} = baseInput({engineCount: 1});
		yield* runStandUp(input);
		const plan = launched[0];
		assert.isDefined(plan);
		return plan as LaunchPlan;
	});

	const TARGET = "operator-session";

	it.effect(
		"launchSessionInTmux (first pane) opens the crew window into the resolved session and captures its id (#3424)",
		() =>
			Effect.gen(function* () {
				const plan = yield* captureOnePlan;
				// the first pane runs `new-window -P -F '#{window_id}'`; its stdout is the crew window id.
				const {runner, argvLog} = scriptedTmux([exited(0, {stdout: "@7\n"})]);
				const result = yield* launchSessionInTmux(plan, TARGET, undefined, runner);

				assert.strictEqual(
					result.window,
					"@7",
					"the captured crew window id threads to later panes",
				);
				assert.strictEqual(result.pane, plan.placement.paneLabel);
				assert.strictEqual(result.pid, 4242);
				// the crew window opens into the RESOLVED session (the caller's, #3418), not a hardcoded one.
				assert.deepStrictEqual(argvLog[0], [
					"new-window",
					"-t",
					TARGET,
					"-n",
					CREW_WINDOW,
					"-P",
					"-F",
					"#{window_id}",
					"claude",
					...plan.bind.argv,
				]);
			}),
	);

	it.effect(
		"launchSessionInTmux (later pane) splits into the crew window and re-tiles on exit-0 (#3424 AC1,AC2)",
		() =>
			Effect.gen(function* () {
				const plan = yield* captureOnePlan;
				// split-window then select-layout tiled — two tmux clients, both must exit 0.
				const {runner, argvLog} = scriptedTmux([exited(0), exited(0)]);
				const result = yield* launchSessionInTmux(plan, TARGET, "@7", runner);

				assert.strictEqual(result.window, "@7", "a later pane rides the threaded crew window id");
				assert.strictEqual(result.pane, plan.placement.paneLabel);
				assert.deepStrictEqual(argvLog[0], [
					"split-window",
					"-t",
					"@7",
					"claude",
					...plan.bind.argv,
				]);
				assert.deepStrictEqual(argvLog[1], ["select-layout", "-t", "@7", "tiled"]);
			}),
	);

	it.effect(
		"launchSessionInTmux (first pane) fails closed on an async non-zero exit — the swallowed failure #3418",
		() =>
			Effect.gen(function* () {
				const plan = yield* captureOnePlan;
				const {runner} = scriptedTmux([exited(1)]);
				const err = yield* Effect.flip(launchSessionInTmux(plan, TARGET, undefined, runner));

				assert.instanceOf(err, StandUpLaunchError);
				assert.strictEqual(err.pane, plan.placement.paneLabel);
				assert.strictEqual(err.role, plan.session.role);
			}),
	);

	it.effect(
		"launchSessionInTmux (later pane) fails closed when the split-window exits non-zero (#3424 AC3)",
		() =>
			Effect.gen(function* () {
				const plan = yield* captureOnePlan;
				const {runner} = scriptedTmux([exited(1)]);
				const err = yield* Effect.flip(launchSessionInTmux(plan, TARGET, "@7", runner));

				assert.instanceOf(err, StandUpLaunchError);
				assert.strictEqual(err.pane, plan.placement.paneLabel);
				assert.strictEqual(err.role, plan.session.role);
				assert.include(err.reason, "split-window");
			}),
	);

	it.effect(
		"launchSessionInTmux (later pane) fails closed when select-layout exits non-zero (#3424 AC3)",
		() =>
			Effect.gen(function* () {
				const plan = yield* captureOnePlan;
				// split-window succeeds, but the re-tile does not — still fails loud, no silently-untiled crew.
				const {runner} = scriptedTmux([exited(0), exited(1)]);
				const err = yield* Effect.flip(launchSessionInTmux(plan, TARGET, "@7", runner));

				assert.instanceOf(err, StandUpLaunchError);
				assert.include(err.reason, "select-layout tiled");
			}),
	);

	it.effect("launchSessionInTmux fails closed on a spawn-level error (tmux missing)", () =>
		Effect.gen(function* () {
			const plan = yield* captureOnePlan;
			const {runner} = scriptedTmux([exited(null, {spawnError: "spawn tmux ENOENT"})]);
			const err = yield* Effect.flip(launchSessionInTmux(plan, TARGET, undefined, runner));

			assert.instanceOf(err, StandUpLaunchError);
			assert.include(err.reason, "ENOENT");
		}),
	);

	it.effect(
		"resolveTargetTmuxSession returns the caller's CURRENT session when inside tmux (the default path)",
		() =>
			Effect.gen(function* () {
				// display-message prints the current session name — no session is ever created inside tmux.
				const {runner, argvLog} = scriptedTmux([exited(0, {stdout: "my-session\n"})]);
				const session = yield* resolveTargetTmuxSession(
					{inTmux: true, fallbackSession: FALLBACK_TMUX_SESSION},
					runner,
				);

				assert.strictEqual(session, "my-session");
				assert.deepStrictEqual(argvLog, [["display-message", "-p", "#{session_name}"]]);
			}),
	);

	it.effect(
		"resolveTargetTmuxSession falls back to a CREATED named session when outside tmux",
		() =>
			Effect.gen(function* () {
				// outside tmux: no display-message; has-session (absent) → new-session creates the fallback.
				const {runner, argvLog} = scriptedTmux([exited(1), exited(0)]);
				const session = yield* resolveTargetTmuxSession(
					{inTmux: false, fallbackSession: FALLBACK_TMUX_SESSION},
					runner,
				);

				assert.strictEqual(session, FALLBACK_TMUX_SESSION);
				assert.deepStrictEqual(argvLog, [
					["has-session", "-t", FALLBACK_TMUX_SESSION],
					["new-session", "-d", "-s", FALLBACK_TMUX_SESSION],
				]);
			}),
	);

	it.effect(
		"resolveTargetTmuxSession falls back to the created session when the current name is unreadable",
		() =>
			Effect.gen(function* () {
				// inside tmux but display-message fails → fall through to has-session (present, exit-0).
				const {runner, argvLog} = scriptedTmux([exited(1), exited(0)]);
				const session = yield* resolveTargetTmuxSession(
					{inTmux: true, fallbackSession: FALLBACK_TMUX_SESSION},
					runner,
				);

				assert.strictEqual(session, FALLBACK_TMUX_SESSION);
				assert.deepStrictEqual(argvLog, [
					["display-message", "-p", "#{session_name}"],
					["has-session", "-t", FALLBACK_TMUX_SESSION],
				]);
			}),
	);

	it.effect("resolveTargetTmuxSession fails loud when the fallback session cannot be created", () =>
		Effect.gen(function* () {
			const {runner} = scriptedTmux([exited(1), exited(1)]);
			const err = yield* Effect.flip(
				resolveTargetTmuxSession({inTmux: false, fallbackSession: "crew"}, runner),
			);

			assert.instanceOf(err, TmuxSessionEnsureError);
			assert.strictEqual(err.session, "crew");
		}),
	);

	it.effect("ensureNamedTmuxSession is a no-op create when the session already exists", () =>
		Effect.gen(function* () {
			const {runner, argvLog} = scriptedTmux([exited(0)]);
			yield* ensureNamedTmuxSession("crew", runner);

			// has-session exit-0 short-circuits — no `new-session` is ever run.
			assert.deepStrictEqual(argvLog, [["has-session", "-t", "crew"]]);
		}),
	);
});

// The abort render is the operator's whole diagnostic on a fail-closed boot — `String(error)` on a
// TaggedError is tag-only, so both `reason`-carrying union members must surface their rich fields (#3438).
describe("renderStandUpError", () => {
	it("surfaces role, pane, and reason for a StandUpLaunchError", () => {
		const reason = `tmux new-window for pane "triage" exited 127 (no live pane)`;
		const rendered = renderStandUpError(
			new StandUpLaunchError({role: "triage", pane: "triage", reason}),
		);

		assert.include(rendered, "StandUpLaunchError");
		assert.include(rendered, "role=triage");
		assert.include(rendered, "pane=triage");
		assert.include(rendered, `reason=${reason}`);
	});

	it("surfaces session and reason for a TmuxSessionEnsureError", () => {
		const reason = "has-session missed and new-session failed to come up";
		const rendered = renderStandUpError(new TmuxSessionEnsureError({session: "crew", reason}));

		assert.include(rendered, "TmuxSessionEnsureError");
		assert.include(rendered, "session=crew");
		assert.include(rendered, `reason=${reason}`);
	});
});
