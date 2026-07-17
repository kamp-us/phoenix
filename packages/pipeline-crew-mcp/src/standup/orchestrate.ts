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
	type CrewSessionBinUnresolvableError,
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
 * The named fallback tmux session could not be ensured (the `has-session` probe missed AND the create failed
 * to come up). This is only the OUTSIDE-tmux edge: run inside tmux, stand-up opens windows in the caller's
 * current session and never creates one (founder ruling #3418) — a created session is the fallback alone.
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
	/** The client's captured stdout — carries `display-message` output for the target-session probe. */
	readonly stdout: string;
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
		const child = spawn("tmux", [...args], {stdio: ["ignore", "pipe", "ignore"]});
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		let settled = false;
		const settle = (run: TmuxRun) => {
			if (settled) return;
			settled = true;
			child.removeAllListeners();
			resume(Effect.succeed(run));
		};
		child.once("error", (cause) =>
			settle({pid: child.pid, code: null, signal: null, stdout, spawnError: String(cause)}),
		);
		child.once("exit", (code, signal) =>
			settle({pid: child.pid, code, signal, stdout, spawnError: undefined}),
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
	| CrewSessionBinUnresolvableError
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
	/** Resolve the tmux session windows open into — the caller's current session, else a created fallback.
	 * Default: `resolveTargetTmuxSession` (reads `$TMUX` + `display-message`). */
	readonly resolveTargetSession?: () => Effect.Effect<string, TmuxSessionEnsureError>;
	/** Launch one planned session into a window under `targetSession`, bound to its role lease. Default: `launchSessionInTmux`. */
	readonly launch?: (
		plan: LaunchPlan,
		targetSession: string,
	) => Effect.Effect<LaunchedSession, StandUpLaunchError>;
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
 * The named session stand-up falls back to only when run OUTSIDE tmux — inside tmux the caller's own current
 * session is the target and nothing is created (founder ruling #3418). A launcher default, not a config input.
 */
export const FALLBACK_TMUX_SESSION = "crew";

/**
 * Ensure a named tmux session exists: probe `has-session`, and create (`new-session -d`) only when it is
 * absent. This runs ONLY on the outside-tmux fallback path (`resolveTargetTmuxSession`) — a create that does
 * not come up fails closed with `TmuxSessionEnsureError`. The tmux runner is injected so the has-session /
 * create branches are unit-tested without a real tmux.
 */
export const ensureNamedTmuxSession = (
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
 * Resolve which tmux session stand-up opens its windows into (founder ruling #3418 — the fix's inverted half:
 * open windows in the operator's CURRENT session, never a hardcoded `crew`). Inside tmux (`$TMUX` set) the
 * caller's current session name is read via `display-message -p '#{session_name}'`, resolved through the
 * inherited `$TMUX` — that session always exists, so the old "session doesn't exist" failure dissolves. Only
 * OUTSIDE tmux (or when the current-session name can't be read) is a session created: the named fallback,
 * ensured to exist. `inTmux` + the runner are injected so both paths are unit-tested without a real tmux.
 */
export const resolveTargetTmuxSession = (
	opts: {readonly inTmux: boolean; readonly fallbackSession: string},
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<string, TmuxSessionEnsureError> =>
	Effect.gen(function* () {
		if (opts.inTmux) {
			const shown = yield* runTmuxCommand(["display-message", "-p", "#{session_name}"]);
			const name = shown.stdout.trim();
			if (shown.spawnError === undefined && shown.code === 0 && name.length > 0) return name;
			// Inside tmux but the current session name was unreadable — fall through to the created fallback.
		}
		yield* ensureNamedTmuxSession(opts.fallbackSession, runTmuxCommand);
		return opts.fallbackSession;
	});

/** The production target-session resolver: current session when inside tmux, the named fallback otherwise. */
const resolveTargetSessionDefault = (): Effect.Effect<string, TmuxSessionEnsureError> =>
	resolveTargetTmuxSession({
		inTmux: process.env.TMUX !== undefined,
		fallbackSession: FALLBACK_TMUX_SESSION,
	});

/**
 * The production launcher: open a tmux window under `targetSession` (the resolved caller session) and run
 * `claude` there with the session's launch bind, then CONFIRM the window came up before counting it. `runTmux`
 * awaits the client's async exit, so a spawn failure or any non-zero exit — the swallowed failure of #3418 —
 * fails closed with `StandUpLaunchError` naming the role + window; a `LaunchedSession` therefore only ever
 * exists for a confirmed-live launch. The tmux runner is injected so the exit-code paths are unit-tested.
 */
export const launchSessionInTmux = (
	plan: LaunchPlan,
	targetSession: string,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<LaunchedSession, StandUpLaunchError> =>
	Effect.gen(function* () {
		const {placement, bind, session} = plan;
		const run = yield* runTmuxCommand([
			"new-window",
			"-t",
			targetSession,
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
							: `tmux new-window for "${placement.window}" in session "${targetSession}" exited ${run.code ?? run.signal} (no live pane)`,
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
		const resolveTargetSession = input.resolveTargetSession ?? resolveTargetSessionDefault;
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
				// The role's configured model tier → the session's `--model` (#3423); undefined for a
				// role that set none, so bind emits no `--model` and it boots on the CLI default.
				tier: config.roleTiers[session.role],
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

		// Resolve the target tmux session before placing any window: the caller's CURRENT session inside
		// tmux (which always exists — dissolving the fresh-machine "no crew session" failure), else a
		// created fallback (founder ruling #3418). Last precondition before the no-partial-crew launch loop.
		const targetSession = yield* resolveTargetSession();
		// Wrap so `forEach`'s index arg never lands on the launcher's optional tmux-runner param.
		const launched = yield* Effect.forEach(plans, (plan) => launch(plan, targetSession));
		return {tracker, launched};
	});
