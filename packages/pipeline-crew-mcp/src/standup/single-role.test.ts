/**
 * standup/single-role — dynamic single-member membership ops (issue #3519). These tests pin the two
 * commands' contracts with every side effect injected (no real tmux/filesystem/`claude`), the same idiom
 * orchestrate.test.ts uses:
 *   - `spawn-role` reuses the shared per-role launch step and SPLITS the new pane into the RUNNING crew
 *     window (intoWindow defined) — never opens a new one — registering only its own pane's scope; it
 *     spawns any roster role, including the on-demand human-in-the-loop cartographer (which boots idle,
 *     no boot turn, #3524); it fails closed when no crew window is up.
 *   - `retire-role` finds the one member's pane by its `--name` displayName, kills it, and reclaims its
 *     inbox socket + launcher cwd — validating the instance against the role kind, and failing closed on
 *     an ambiguous / absent pane or a failed kill (no half-teardown).
 */
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {inboxAddressFor} from "../crew/index.ts";
import {
	DEFAULT_CONFIG_PATH,
	decodeLaunchConfig,
	type LaunchConfig,
	type LaunchConfigError,
} from "./config.ts";
import type {TrackerHandle, TrackerNotServingError} from "./ensure-tracker.ts";
import {
	type CrewMcpEntry,
	CrewPaneKillError,
	CrewPaneNotFoundError,
	CrewWindowNotRunningError,
	findCrewPaneId,
	type LaunchedSession,
	type LaunchPlan,
	type ProjectScopeRegistrar,
	type RetireArtifacts,
	RetireRoleArgError,
	resolveCrewWindowId,
	retireRole,
	type SeatToolsetReader,
	type SpawnRoleInput,
	spawnRole,
	type TmuxRun,
	type TmuxRunner,
} from "./index.ts";

const PINNED = "2.1.212";
const SERVER = "@kampus/pipeline-crew-mcp";

/** spawnRole reaches the platform through buildLaunchPlan's FileSystem/Path seam — provide the real Node platform. */
const spawn = (input: SpawnRoleInput) => spawnRole(input).pipe(Effect.provide(NodeServices.layer));

const rawConfigAt = (cliVersion: string): unknown => ({
	cliVersion,
	roles: {
		"chief-of-staff": {tier: "opus"},
		cartographer: {tier: "fable"},
		"intake-desk": {tier: "fable"},
		"engineering-manager": {tier: "opus", count: 2, wipCap: {productLanes: 1, platformLanes: 1}},
	},
	channels: {mode: "development", servers: [`server:${SERVER}`], allowedChannelPlugins: []},
});

const configAt = (cliVersion: string): Effect.Effect<LaunchConfig, LaunchConfigError> =>
	decodeLaunchConfig(rawConfigAt(cliVersion), DEFAULT_CONFIG_PATH);

const RESOLVED_SESSION = "operator-session";
const CREW_WINDOW_ID = "@7";
const RUN_ID = "spawn0";

/** A recording launcher: captures the plan + intoWindow it was handed, and returns a fixed `LaunchedSession`. */
const recordingLauncher = () => {
	const calls: {plan: LaunchPlan; targetSession: string; intoWindow: string | undefined}[] = [];
	const launch = (
		plan: LaunchPlan,
		targetSession: string,
		intoWindow: string | undefined,
	): Effect.Effect<LaunchedSession, never> => {
		calls.push({plan, targetSession, intoWindow});
		return Effect.succeed({
			role: plan.session.role,
			address: plan.session.address,
			window: intoWindow ?? "@new",
			pane: plan.placement.paneLabel,
			pid: 5150,
		});
	};
	return {calls, launch};
};

/** A recording project-scope registrar — captures the single pane entry spawn-role registers; touches no real config. */
const recordingProjectScope = () => {
	const registered: CrewMcpEntry[][] = [];
	const cwdCalls: {runId: string; paneLabel: string}[] = [];
	const registrar: ProjectScopeRegistrar = {
		reap: () => Effect.void,
		paneCwd: (_projectRoot, runId, paneLabel) =>
			Effect.sync(() => {
				cwdCalls.push({runId, paneLabel});
				return `/fake-cwd/${runId}/${paneLabel}`;
			}),
		register: (input) =>
			Effect.sync(() => {
				registered.push(input.entries.map((e) => ({...e})));
			}),
	};
	return {registrar, registered, cwdCalls};
};

const trackerHandle: TrackerHandle = {pid: 4242, socketPath: "/tmp/crew.sock"};
const recordingTracker = (
	result: Effect.Effect<TrackerHandle, TrackerNotServingError> = Effect.succeed(trackerHandle),
) => {
	let calls = 0;
	const ensureTracker = (_r: string) => {
		calls++;
		return result;
	};
	return {ensureTracker, calls: () => calls};
};

/** A recording tmux runner: replays a scripted `TmuxRun` per call (repeating the last) and logs argv. */
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

/** A `list-windows` output that includes a live `crew` window — what spawn-role splits into. */
const windowsWithCrew = (crewId: string): TmuxRun =>
	exited(0, {stdout: `@0 main\n${crewId} crew\n@9 logs\n`});

const baseSpawn = (
	role: SpawnRoleInput["role"],
	overrides: Partial<SpawnRoleInput> = {},
): {
	input: SpawnRoleInput;
	launchCalls: {plan: LaunchPlan; targetSession: string; intoWindow: string | undefined}[];
	registered: CrewMcpEntry[][];
	trackerCalls: () => number;
	argvLog: string[][];
} => {
	const {calls, launch} = recordingLauncher();
	const {registrar, registered} = recordingProjectScope();
	const {ensureTracker, calls: trackerCalls} = recordingTracker();
	const {runner, argvLog} = scriptedTmux([windowsWithCrew(CREW_WINDOW_ID)]);
	return {
		launchCalls: calls,
		registered,
		trackerCalls,
		argvLog,
		input: {
			projectRoot: "/repo",
			role,
			config: configAt(PINNED),
			readVersionOutput: Effect.succeed(`${PINNED} (Claude Code)`),
			// The seat-toolset assert (#3764) stubbed to a declaration that resolves intact — `/repo` is a
			// fake root with no crew defs under it, and these tests are about the membership op.
			readSeatToolset: (() =>
				Effect.succeed({
					_tag: "allowlist" as const,
					tools: ["Read", "Bash", "Task"],
					disallowedTools: [],
				})) satisfies SeatToolsetReader,
			instanceId: (() => {
				let n = 0;
				return () => `e${n++}`;
			})(),
			runId: () => RUN_ID,
			localScope: registrar,
			ensureTracker,
			resolveTargetSession: () => Effect.succeed(RESOLVED_SESSION),
			runTmux: runner,
			launch,
			...overrides,
		},
	};
};

describe("standup/single-role — spawn-role (issue #3519)", () => {
	it.effect(
		"spawns a bridge as a SPLIT into the running crew window, joining the tracker (AC1)",
		() =>
			Effect.gen(function* () {
				const h = baseSpawn("chief-of-staff");
				const result = yield* spawn(h.input);

				// tracker reached (idempotent join), one member launched
				assert.strictEqual(h.trackerCalls(), 1);
				assert.strictEqual(result.launched.role, "chief-of-staff");
				assert.strictEqual(result.launched.pane, "chief-of-staff");

				// the pane SPLITS into the resolved crew window id (intoWindow DEFINED) — never a new window
				assert.strictEqual(h.launchCalls.length, 1);
				const call = h.launchCalls[0];
				assert.strictEqual(call?.intoWindow, CREW_WINDOW_ID);
				assert.strictEqual(call?.targetSession, RESOLVED_SESSION);

				// exactly ONE pane's project scope is registered (the new member's), no sibling touched
				assert.strictEqual(h.registered.length, 1);
				assert.strictEqual(h.registered[0]?.length, 1);
				assert.strictEqual(h.registered[0]?.[0]?.cwd, `/fake-cwd/${RUN_ID}/chief-of-staff`);

				// the crew-window resolution probe ran list-windows against the resolved session
				assert.deepStrictEqual(h.argvLog[0], [
					"list-windows",
					"-t",
					RESOLVED_SESSION,
					"-F",
					"#{window_id} #{window_name}",
				]);
			}),
	);

	it.effect(
		"spawns an engine with a fresh per-instance address that deconflicts by claims (AC4)",
		() =>
			Effect.gen(function* () {
				const h = baseSpawn("engineering-manager");
				const result = yield* spawn(h.input);

				const plan = h.launchCalls[0]?.plan;
				// engine → per-instance address (the same discriminator that keeps engine inboxes + resource
				// claims collision-free), pane labelled by the instance id, split into the running window
				assert.strictEqual(plan?.session.kind, "engine");
				assert.strictEqual(result.launched.address, inboxAddressFor("engineering-manager", "e0"));
				assert.strictEqual(result.launched.pane, "e0");
				// a self-driving engine carries its boot turn (#3516) — one positional prompt
				assert.strictEqual(plan?.bind.bootPromptArg.length, 1);
			}),
	);

	it.effect(
		"spawns the on-demand HITL cartographer (not autoboot-gated) and it boots idle (#3524)",
		() =>
			Effect.gen(function* () {
				// the cartographer is human-in-the-loop — excluded from the STAND-UP set, but spawn-role is the
				// explicit human spawn, so it IS launchable here; bind gives it NO boot turn (boots idle).
				const h = baseSpawn("cartographer");
				const result = yield* spawn(h.input);
				assert.strictEqual(result.launched.role, "cartographer");
				assert.strictEqual(h.launchCalls[0]?.plan.bind.bootPromptArg.length, 0);
			}),
	);

	it.effect("fails closed when no crew window is running — run stand-up first", () =>
		Effect.gen(function* () {
			const {runner} = scriptedTmux([exited(0, {stdout: "@0 main\n@9 logs\n"})]); // no `crew` window
			const h = baseSpawn("intake-desk", {runTmux: runner});
			const error = yield* Effect.flip(spawn(h.input));
			assert.instanceOf(error, CrewWindowNotRunningError);
			// nothing launched — the split never happened
			assert.strictEqual(h.launchCalls.length, 0);
		}),
	);

	it.effect("aborts on a drifted CLI pin before ensuring the tracker or launching", () =>
		Effect.gen(function* () {
			const h = baseSpawn("chief-of-staff", {
				readVersionOutput: Effect.succeed("2.0.0 (Claude Code)"),
			});
			yield* Effect.flip(spawn(h.input));
			assert.strictEqual(h.trackerCalls(), 0);
			assert.strictEqual(h.launchCalls.length, 0);
		}),
	);
});

describe("standup/single-role — resolveCrewWindowId", () => {
	it.effect("returns the id of the crew window", () =>
		Effect.gen(function* () {
			const {runner} = scriptedTmux([windowsWithCrew("@42")]);
			const id = yield* resolveCrewWindowId(RESOLVED_SESSION, runner);
			assert.strictEqual(id, "@42");
		}),
	);

	it.effect("fails closed when list-windows errors", () =>
		Effect.gen(function* () {
			const {runner} = scriptedTmux([exited(1)]);
			const error = yield* Effect.flip(resolveCrewWindowId(RESOLVED_SESSION, runner));
			assert.instanceOf(error, CrewWindowNotRunningError);
		}),
	);
});

// ── retire-role ────────────────────────────────────────────────────────────────────────────────

/** A recording artifact cleanup — captures the inbox-socket + cwd removals without touching the filesystem. */
const recordingArtifacts = () => {
	const sockets: {role: string; instance: string}[] = [];
	const cwds: {projectRoot: string; cwdLabel: string}[] = [];
	const artifacts: RetireArtifacts = {
		removeInboxSocket: (role, instance) => Effect.sync(() => void sockets.push({role, instance})),
		removePaneCwd: (projectRoot, cwdLabel) =>
			Effect.sync(() => void cwds.push({projectRoot, cwdLabel})),
	};
	return {artifacts, sockets, cwds};
};

/** A `list-panes` line for a crew member whose start command carries its `--name <displayName>` (the match key). */
const paneLine = (paneId: string, displayName: string): string =>
	`${paneId}::zsh -lic 'claude' '--agent' 'crew-role' '--name' '${displayName}'`;

describe("standup/single-role — retire-role (issue #3519)", () => {
	it.effect("retires a bridge: finds its pane, kills it, reclaims socket + cwd (AC2)", () =>
		Effect.gen(function* () {
			const {artifacts, sockets, cwds} = recordingArtifacts();
			const {runner, argvLog} = scriptedTmux([
				exited(0, {stdout: `%1::other pane\n${paneLine("%3", "chief-of-staff")}\n`}),
				exited(0), // kill-pane
			]);
			const result = yield* retireRole({
				projectRoot: "/repo",
				role: "chief-of-staff",
				runTmux: runner,
				artifacts,
			});

			assert.strictEqual(result.paneId, "%3");
			assert.deepStrictEqual(argvLog[1], ["kill-pane", "-t", "%3"]);
			// lease frees by TTL (connection-is-lease); the launcher reclaims socket + cwd by the pane label
			assert.deepStrictEqual(sockets, [{role: "chief-of-staff", instance: ""}]);
			assert.deepStrictEqual(cwds, [{projectRoot: "/repo", cwdLabel: "chief-of-staff"}]);
		}),
	);

	it.effect("retires ONE engine instance by id, leaving the others' leases intact (AC4)", () =>
		Effect.gen(function* () {
			const {artifacts, sockets, cwds} = recordingArtifacts();
			const {runner} = scriptedTmux([
				exited(0, {stdout: `${paneLine("%8", "engineering-manager-e0")}\n`}),
				exited(0),
			]);
			const result = yield* retireRole({
				projectRoot: "/repo",
				role: "engineering-manager",
				instance: "e0",
				runTmux: runner,
				artifacts,
			});
			assert.strictEqual(result.paneId, "%8");
			assert.strictEqual(result.instance, "e0");
			// socket + cwd keyed by the instance id — no sibling engine's artifacts touched
			assert.deepStrictEqual(sockets, [{role: "engineering-manager", instance: "e0"}]);
			assert.deepStrictEqual(cwds, [{projectRoot: "/repo", cwdLabel: "e0"}]);
		}),
	);

	it.effect("rejects an engine retire with no instance (cardinality-N needs a name)", () =>
		Effect.gen(function* () {
			const {artifacts} = recordingArtifacts();
			const error = yield* Effect.flip(
				retireRole({projectRoot: "/repo", role: "engineering-manager", artifacts}),
			);
			assert.instanceOf(error, RetireRoleArgError);
		}),
	);

	it.effect("rejects a bridge retire that carries an instance (a singleton takes none)", () =>
		Effect.gen(function* () {
			const {artifacts} = recordingArtifacts();
			const error = yield* Effect.flip(
				retireRole({projectRoot: "/repo", role: "intake-desk", instance: "x", artifacts}),
			);
			assert.instanceOf(error, RetireRoleArgError);
		}),
	);

	it.effect("fails closed when no pane matches (already retired / crew down)", () =>
		Effect.gen(function* () {
			const {artifacts, sockets} = recordingArtifacts();
			const {runner} = scriptedTmux([exited(0, {stdout: "%1::some unrelated pane\n"})]);
			const error = yield* Effect.flip(
				retireRole({projectRoot: "/repo", role: "cartographer", runTmux: runner, artifacts}),
			);
			assert.instanceOf(error, CrewPaneNotFoundError);
			// no cleanup ran — nothing was killed
			assert.strictEqual(sockets.length, 0);
		}),
	);

	it.effect("fails closed (no kill) when the match is ambiguous", () =>
		Effect.gen(function* () {
			const {artifacts} = recordingArtifacts();
			const {runner, argvLog} = scriptedTmux([
				exited(0, {
					stdout: `${paneLine("%2", "chief-of-staff")}\n${paneLine("%5", "chief-of-staff")}\n`,
				}),
			]);
			const error = yield* Effect.flip(
				retireRole({projectRoot: "/repo", role: "chief-of-staff", runTmux: runner, artifacts}),
			);
			assert.instanceOf(error, CrewPaneNotFoundError);
			// only the list-panes probe ran — no kill-pane was attempted
			assert.strictEqual(argvLog.length, 1);
		}),
	);

	it.effect("fails closed and does NOT reclaim artifacts when kill-pane fails", () =>
		Effect.gen(function* () {
			const {artifacts, sockets, cwds} = recordingArtifacts();
			const {runner} = scriptedTmux([
				exited(0, {stdout: `${paneLine("%3", "chief-of-staff")}\n`}),
				exited(1), // kill-pane fails
			]);
			const error = yield* Effect.flip(
				retireRole({projectRoot: "/repo", role: "chief-of-staff", runTmux: runner, artifacts}),
			);
			assert.instanceOf(error, CrewPaneKillError);
			assert.strictEqual(sockets.length, 0);
			assert.strictEqual(cwds.length, 0);
		}),
	);
});

describe("standup/single-role — findCrewPaneId", () => {
	it.effect("matches a crew pane on its displayName + claude marker", () =>
		Effect.gen(function* () {
			const {runner} = scriptedTmux([
				exited(0, {stdout: `%1::vim\n${paneLine("%4", "engineering-manager-e1")}\n`}),
			]);
			const paneId = yield* findCrewPaneId("engineering-manager-e1", runner);
			assert.strictEqual(paneId, "%4");
		}),
	);
});
