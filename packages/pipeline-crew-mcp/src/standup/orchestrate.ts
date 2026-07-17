/**
 * standup/orchestrate — the one stand-up command: compose every launcher primitive into a single
 * boot of the whole crew from the operator config (epic #3237, issue #3299). This module owns the
 * ORDER and the composition only; every step is a merged child it wires read-only, never
 * reimplements — config (#3293), version-assert (#3295), ensure-tracker (#3294), session-set
 * (#3297), bind (#3296), tmux-placement (#3298).
 *
 * The one non-obvious thing: the orchestration is FAIL-LOUD with NO PARTIAL CREW. The steps run in
 * the mandated order — read config → assert the pinned CLI version → ensure the tracker → derive the
 * roster session set → build EVERY per-session bind + compute ALL tmux placements → launch. Every
 * bind and every placement is resolved (and validated) BEFORE the first session launches, so any
 * precondition failure — a drifted CLI pin, a missing config dimension, an inert channel, a colliding
 * tmux window — aborts with a named error while zero sessions are up, never a half-launched
 * crew. No session is hand-launched: the launch of each `claude` session, bound to its role lease, is
 * the injected `launch` step the orchestration drives for the whole derived set.
 *
 * The side-effecting steps are injected (defaulting to production) so the composition is pure over
 * its inputs and unit-testable end to end — the same injection idiom version-assert (its version
 * reader) and session-set (its instance-id generator) already use.
 */
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {Effect, Schema} from "effect";
import {SESSION_SERVER_NAME} from "../crew/index.ts";
import {
	buildSessionBind,
	type ChannelPluginNotAllowedError,
	type CrewServerNotRegisteredError,
	type SessionBind,
} from "./bind.ts";
import {type LaunchConfig, type LaunchConfigError, readLaunchConfig} from "./config.ts";
import {
	ensureTrackerRunning,
	type TrackerHandle,
	type TrackerNotServingError,
} from "./ensure-tracker.ts";
import {type CrewSession, deriveSessionSet} from "./session-set.ts";
import {
	computeTmuxPlacement,
	DEFAULT_TMUX_SESSION,
	type PlacementTarget,
	type RosterSession,
	type TmuxWindowCollisionError,
} from "./tmux-placement.ts";
import {
	assertPinnedCliVersion,
	type CliVersionAssertError,
	readInstalledCliVersionOutput,
} from "./version-assert.ts";

/** A `claude` session that could not be launched into its tmux window — carries the window + role it named. */
export class StandUpLaunchError extends Schema.TaggedErrorClass<StandUpLaunchError>()(
	"@kampus/pipeline-crew-mcp/standup/StandUpLaunchError",
	{
		role: Schema.String,
		window: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * The launcher-default tmux session could not be ensured (the `has-session` probe missed AND the create
 * failed to come up). This is the fresh-machine gap that made every `new-window -t crew` fail while
 * stand-up still counted success — see ADR 0189 for why the session name is derived, not configured (#3418).
 */
export class TmuxSessionEnsureError extends Schema.TaggedErrorClass<TmuxSessionEnsureError>()(
	"@kampus/pipeline-crew-mcp/standup/TmuxSessionEnsureError",
	{
		session: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * The outcome of running a `tmux` client to exit: its pid and exit code/signal, plus — when the binary
 * itself could not be spawned or emitted `error` — a spawn-level message. `code === 0` with no `spawnError`
 * is the only success; every other shape is a launch that did not come up.
 */
export interface TmuxRun {
	readonly pid: number | undefined;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnError: string | undefined;
}

/** Run a `tmux` client command to its exit. Injected in tests to drive the exit-code paths without a real tmux. */
export type TmuxRunner = (args: readonly string[]) => Effect.Effect<TmuxRun>;

/**
 * Run `tmux <args>` and resolve once the client process EXITS, carrying its exit code — the async exit the
 * old `Effect.try`-sync-only launcher never inspected (#3418). No detach/unref: `tmux` is client-server, so
 * the CLI is a short-lived client that hands the request to the tmux server and exits (bounded to await);
 * the `claude` process it places lives under the tmux server and outlives this launcher regardless. Never
 * fails — an operational spawn failure (ENOENT/EACCES) arrives on the async `error` event, captured as
 * `spawnError` data so each caller maps it to its own typed error (no raw try/catch: `spawn` reports
 * operational errors via `error`, not a throw). This mirrors ensure-tracker's `Effect.callback` node-event idiom.
 */
const runTmux: TmuxRunner = (args) =>
	Effect.callback<TmuxRun>((resume) => {
		const child = spawn("tmux", [...args], {stdio: "ignore"});
		let settled = false;
		const settle = (run: TmuxRun) => {
			if (settled) return;
			settled = true;
			child.removeAllListeners();
			resume(Effect.succeed(run));
		};
		child.once("error", (cause) =>
			settle({pid: child.pid, code: null, signal: null, spawnError: String(cause)}),
		);
		child.once("exit", (code, signal) =>
			settle({pid: child.pid, code, signal, spawnError: undefined}),
		);
	});

/** One derived session's full launch plan: its roster identity, its launch bind (argv), and its tmux placement. */
export interface LaunchPlan {
	readonly session: CrewSession;
	readonly bind: SessionBind;
	readonly placement: PlacementTarget;
}

/** A launched crew session: the role + lease it came up holding, the tmux window it lives in, and its pid. */
export interface LaunchedSession {
	readonly role: string;
	/** The role-lease key inbox address the session-set minted (`inbox://<role>[/<instance>]`). */
	readonly address: string;
	readonly window: string;
	readonly pid: number | undefined;
}

/** Every way stand-up can abort — the union of every wired child's error plus the launch error. */
export type StandUpError =
	| LaunchConfigError
	| CliVersionAssertError
	| TrackerNotServingError
	| CrewServerNotRegisteredError
	| ChannelPluginNotAllowedError
	| TmuxWindowCollisionError
	| TmuxSessionEnsureError
	| StandUpLaunchError;

export interface StandUpInput {
	/** The project root the tracker + every session join (the per-project socket key). */
	readonly projectRoot: string;
	/** The channel-ref name each session's own crew MCP server registers under. Default: `SESSION_SERVER_NAME`. */
	readonly serverName?: string;
	/** The launch dimensions to stand up under. Default: read the operator crew config (`readLaunchConfig`). */
	readonly config?: Effect.Effect<LaunchConfig, LaunchConfigError>;
	/** The installed-CLI-version reader the pin is asserted against. Default: the real `claude --version`. */
	readonly readVersionOutput?: Effect.Effect<string, unknown>;
	/** Start-or-reuse the per-project tracker. Default: `ensureTrackerRunning` (detached standing process). */
	readonly ensureTracker?: (
		projectRoot: string,
	) => Effect.Effect<TrackerHandle, TrackerNotServingError>;
	/** Mints each engine instance's distinct id. Default: `randomUUID` (the generator sessions use at runtime). */
	readonly instanceId?: () => string;
	/** Ensure the launcher-default tmux session exists before any window is placed. Default: `ensureCrewTmuxSession`. */
	readonly ensureTmuxSession?: (session: string) => Effect.Effect<void, TmuxSessionEnsureError>;
	/** Launch one planned session into its tmux window bound to its role lease. Default: `launchSessionInTmux`. */
	readonly launch?: (plan: LaunchPlan) => Effect.Effect<LaunchedSession, StandUpLaunchError>;
}

/** What a completed stand-up returns: the tracker it ensured and every session it launched, in roster order. */
export interface StandUpResult {
	readonly tracker: TrackerHandle;
	readonly launched: readonly LaunchedSession[];
}

/**
 * Project a derived `CrewSession` onto the `RosterSession` tmux-placement consumes: a bridge places
 * on a window named by its role slug, an engine on its generated per-instance id (an operator cannot
 * name N dynamic engines). Both window names derive from identity — there is no config tmux dimension.
 */
const toRosterSession = (session: CrewSession): RosterSession =>
	session.kind === "engine"
		? {kind: "engine", id: session.instance}
		: {kind: "bridge", role: session.role};

/**
 * Ensure the launcher-default tmux session exists before any window is placed: probe `has-session`, and
 * create (`new-session -d`) only when it is absent — the idempotent guard that closes the fresh-machine gap
 * where `new-window -t crew` failed for a missing session (#3418). A create that itself does not come up
 * fails closed with `TmuxSessionEnsureError`, so stand-up never launches into a session it could not confirm.
 * The tmux runner is injected so the has-session/create branches are unit-tested without a real tmux.
 */
export const ensureCrewTmuxSession = (
	session: string,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<void, TmuxSessionEnsureError> =>
	Effect.gen(function* () {
		const probe = yield* runTmuxCommand(["has-session", "-t", session]);
		if (probe.spawnError === undefined && probe.code === 0) return;
		const created = yield* runTmuxCommand(["new-session", "-d", "-s", session]);
		if (created.spawnError !== undefined || created.code !== 0) {
			return yield* Effect.fail(
				new TmuxSessionEnsureError({
					session,
					reason:
						created.spawnError ??
						`tmux new-session for "${session}" exited ${created.code ?? created.signal}`,
				}),
			);
		}
	});

/**
 * The production launcher: open a tmux window under the launcher-default session and run `claude` there with
 * the session's launch bind, then CONFIRM the window came up before counting it. `runTmux` awaits the client's
 * exit, so a spawn failure or any non-zero exit — the fresh-machine `new-window -t crew` with no `crew` session
 * (#3418) — fails closed with `StandUpLaunchError` naming the role + window; a `LaunchedSession` therefore only
 * ever exists for a confirmed-live launch. The tmux runner is injected so the exit-code paths are unit-tested.
 */
export const launchSessionInTmux = (
	plan: LaunchPlan,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<LaunchedSession, StandUpLaunchError> =>
	Effect.gen(function* () {
		const {placement, bind, session} = plan;
		const run = yield* runTmuxCommand([
			"new-window",
			"-t",
			placement.session,
			"-n",
			placement.window,
			"claude",
			...bind.argv,
		]);
		if (run.spawnError !== undefined || run.code !== 0) {
			return yield* Effect.fail(
				new StandUpLaunchError({
					role: session.role,
					window: placement.window,
					reason:
						run.spawnError !== undefined
							? `cannot launch claude into tmux window "${placement.window}": ${run.spawnError}`
							: `tmux new-window for "${placement.window}" exited ${run.code ?? run.signal} (no live pane) — is the "${placement.session}" session present?`,
				}),
			);
		}
		return {role: session.role, address: session.address, window: placement.window, pid: run.pid};
	});

/**
 * Stand up the whole crew from the operator config, in the mandated order and fail-loud with no
 * partial crew (issue #3299): read config → assert the pinned CLI version → ensure the tracker →
 * derive the roster session set → build every per-session bind + compute all tmux placements →
 * launch each session bound to its role lease. Every derivation and validation completes before the
 * first launch, so any precondition failure aborts (naming its cause) with zero sessions up.
 */
export const runStandUp = (input: StandUpInput): Effect.Effect<StandUpResult, StandUpError> =>
	Effect.gen(function* () {
		const {projectRoot} = input;
		const serverName = input.serverName ?? SESSION_SERVER_NAME;
		const instanceId = input.instanceId ?? randomUUID;
		const ensureTracker = input.ensureTracker ?? ensureTrackerRunning;
		const ensureTmuxSession = input.ensureTmuxSession ?? ensureCrewTmuxSession;
		const launch = input.launch ?? launchSessionInTmux;

		const config = yield* input.config ?? readLaunchConfig();
		// Fail fast on a version drift before starting the tracker or any session — channels vary
		// across CLI versions, so a mismatch is a stand-up to refuse (version-assert.ts / #3295).
		yield* assertPinnedCliVersion(config, input.readVersionOutput ?? readInstalledCliVersionOutput);
		const tracker = yield* ensureTracker(projectRoot);

		const sessions = deriveSessionSet({engineCount: config.engineCount, instanceId});

		// Resolve EVERY bind + placement before launching anything — this is the no-partial-crew line:
		// an inert channel or a colliding window fails here, while zero sessions are up.
		const binds = yield* Effect.forEach(sessions, (session) =>
			buildSessionBind({
				role: session.role,
				projectRoot,
				serverName,
				// Thread the session-set-derived per-instance identity so the launched engine binds it
				// rather than re-minting its own (#3354 seam 3); a bridge is a singleton and has none.
				instance: session.kind === "engine" ? session.instance : undefined,
				channels: config.channels,
			}),
		);
		const placements = yield* computeTmuxPlacement(sessions.map(toRosterSession));
		// `binds` and `placements` are each derived from `sessions` in order, so the index is always
		// populated; the die guard is the unreachable branch that satisfies noUncheckedIndexedAccess.
		const plans = yield* Effect.forEach(sessions, (session, i) => {
			const bind = binds[i];
			const placement = placements[i];
			return bind !== undefined && placement !== undefined
				? Effect.succeed<LaunchPlan>({session, bind, placement})
				: Effect.die(`stand-up plan zip out of range for session "${session.role}"`);
		});

		// Ensure the launcher-default tmux session exists before placing any window — a missing `crew`
		// session made every `new-window -t crew` fail on a fresh machine while stand-up still reported
		// success (#3418). This is the last precondition before the no-partial-crew launch loop.
		yield* ensureTmuxSession(DEFAULT_TMUX_SESSION);
		// Wrap so `forEach`'s index arg never lands on the launcher's optional tmux-runner param.
		const launched = yield* Effect.forEach(plans, (plan) => launch(plan));
		return {tracker, launched};
	});
