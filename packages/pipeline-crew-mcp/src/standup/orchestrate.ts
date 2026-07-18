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
 * pane label — aborts with a named error while zero sessions are up, never a half-launched
 * crew. No session is hand-launched: the launch of each `claude` session, bound to its role lease, is
 * the injected `launch` step the orchestration drives for the whole derived set (all panes of one
 * tiled crew window, founder ruling #3424).
 *
 * The side-effecting steps are injected (defaulting to production) so the composition is pure over
 * its inputs and unit-testable end to end — the same injection idiom version-assert (its version
 * reader) and session-set (its instance-id generator) already use.
 */
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {rmSync} from "node:fs";
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
import {
	type CrewLocalEntry,
	crewRunRoot,
	ensurePaneCwd,
	LocalScopeWriteError,
	reapCrewLocalScopeFor,
	registerCrewLocalScope,
} from "./register-local-scope.ts";
import {type CrewSession, deriveSessionSet} from "./session-set.ts";
import {
	computeTmuxPlacement,
	type PlacementTarget,
	type RosterSession,
	type TmuxPaneCollisionError,
} from "./tmux-placement.ts";
import {
	assertPinnedCliVersion,
	type CliVersionAssertError,
	readInstalledCliVersionOutput,
} from "./version-assert.ts";

/** A `claude` session that could not be launched into its pane of the crew window — carries the role + pane it named. */
export class StandUpLaunchError extends Schema.TaggedErrorClass<StandUpLaunchError>()(
	"@kampus/pipeline-crew-mcp/standup/StandUpLaunchError",
	{
		role: Schema.String,
		pane: Schema.String,
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

/** One derived session's full launch plan: its roster identity, its launch bind (argv), its tmux placement, and its cwd. */
export interface LaunchPlan {
	readonly session: CrewSession;
	readonly bind: SessionBind;
	readonly placement: PlacementTarget;
	/**
	 * This pane's distinct, git-valid launch cwd — the `~/.claude.json → projects[<cwd>]` key its crew
	 * server is registered under, and the `tmux -c` dir it boots in. Distinct per pane so each sees ONLY
	 * its own persisted-scope entry at boot, never a sibling's (which would storm the role lease, #3444).
	 */
	readonly cwd: string;
}

/** A launched crew session: the role + lease it came up holding, the crew window + pane it lives in, and its pid. */
export interface LaunchedSession {
	readonly role: string;
	/** The role-lease key inbox address the session-set minted (`inbox://<role>[/<instance>]`). */
	readonly address: string;
	/** The single tiled crew window every session shares — a tmux window id/target that later panes split into. */
	readonly window: string;
	/** This session's pane label within the crew window (its role slug or engine instance id). */
	readonly pane: string;
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
	| LocalScopeWriteError
	| TmuxPaneCollisionError
	| TmuxSessionEnsureError
	| StandUpLaunchError;

/**
 * Render a stand-up abort for the operator: the error tag plus its diagnostic data fields. `String(error)` on a
 * `Schema.TaggedErrorClass` prints only the tag and drops the fields — yet the fields are the payload an operator
 * needs (which tmux step + exit code failed, in which role/pane), so surface every schema data field alongside
 * the tag. Field-generic on purpose: every union member's diagnostic surfaces — including both `reason`-carriers,
 * `StandUpLaunchError` (role/pane/reason) and `TmuxSessionEnsureError` (session/reason) — and a future member's
 * fields can't silently regress to tag-only. `Cause.pretty` is not a substitute here: it prints tag + stack but
 * not the schema fields (#3438).
 */
export const renderStandUpError = (error: StandUpError): string => {
	const detail = Object.entries(error)
		.filter(([key]) => key !== "_tag")
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(", ");
	return detail ? `${error._tag} (${detail})` : error._tag;
};

/**
 * The persisted local-scope collaborator the launcher writes each pane's crew server through (#3444) —
 * the one injected seam for the `~/.claude.json` side effects, so the whole boot is unit-tested with no
 * real config file. `reap` sweeps a prior (crashed) run's entries at stand-up start; `paneCwd` mints a
 * pane's distinct git-valid launch cwd (its isolated `projects[]` key); `register` commits every pane's
 * entry in one locked atomic RMW.
 */
export interface LocalScopeRegistrar {
	readonly reap: (
		projectRoot: string,
		serverName: string,
	) => Effect.Effect<void, LocalScopeWriteError>;
	readonly paneCwd: (
		projectRoot: string,
		runId: string,
		paneLabel: string,
	) => Effect.Effect<string, LocalScopeWriteError>;
	readonly register: (
		entries: readonly CrewLocalEntry[],
	) => Effect.Effect<void, LocalScopeWriteError>;
}

/** The production local-scope registrar: the real `~/.claude.json` reaper, per-pane cwd, and locked register. */
export const productionLocalScopeRegistrar: LocalScopeRegistrar = {
	reap: (projectRoot, serverName) => reapCrewLocalScopeFor(projectRoot, serverName),
	paneCwd: (projectRoot, runId, paneLabel) =>
		Effect.try({
			try: () => ensurePaneCwd(projectRoot, runId, paneLabel),
			catch: (cause) =>
				new LocalScopeWriteError({
					configPath: `${crewRunRoot(projectRoot)}/${runId}/${paneLabel}`,
					reason: `cannot ensure pane cwd: ${String(cause)}`,
				}),
		}),
	register: (entries) => registerCrewLocalScope(entries),
};

export interface StandUpInput {
	/** The project root the tracker + every session join (the per-project socket key). */
	readonly projectRoot: string;
	/** The channel-ref name each session's own crew MCP server registers under. Default: `SESSION_SERVER_NAME`. */
	readonly serverName?: string;
	/** Mints the id for this stand-up's per-pane cwd dir tree (`<root>/.claude/crew-run/<runId>/`). Default: `randomUUID`. */
	readonly runId?: () => string;
	/** The persisted local-scope collaborator (#3444). Default: `productionLocalScopeRegistrar` (real `~/.claude.json`). */
	readonly localScope?: LocalScopeRegistrar;
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
	/** Launch one planned session as a pane of the crew window under `targetSession`, bound to its role lease. The
	 * first session (`intoWindow` undefined) opens the crew window and returns its id; every later session splits
	 * into that window id. Default: `launchSessionInTmux`. */
	readonly launch?: (
		plan: LaunchPlan,
		targetSession: string,
		intoWindow: string | undefined,
	) => Effect.Effect<LaunchedSession, StandUpLaunchError>;
}

/** What a completed stand-up returns: the tracker it ensured and every session it launched, in roster order. */
export interface StandUpResult {
	readonly tracker: TrackerHandle;
	readonly launched: readonly LaunchedSession[];
}

/**
 * Project a derived `CrewSession` onto the `RosterSession` tmux-placement consumes: a bridge places
 * on a pane labelled by its role slug, an engine on its generated per-instance id (an operator cannot
 * name N dynamic engines). Both pane labels derive from identity — there is no config tmux dimension.
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

/** The single tiled window every crew pane opens into (founder ruling #3424): one window, all roles visible at once. */
export const CREW_WINDOW = "crew";

/** Map a non-zero exit / spawn error from one tmux step to the fail-loud `StandUpLaunchError` naming the role + pane. */
const launchFailure = (
	session: CrewSession,
	pane: string,
	run: TmuxRun,
	what: string,
): StandUpLaunchError =>
	new StandUpLaunchError({
		role: session.role,
		pane,
		reason:
			run.spawnError !== undefined
				? `cannot ${what} for pane "${pane}": ${run.spawnError}`
				: `tmux ${what} for pane "${pane}" exited ${run.code ?? run.signal} (no live pane)`,
	});

/**
 * The production launcher: place one `claude` session as a PANE of the single crew window under `targetSession`
 * (the resolved caller session, #3418), then CONFIRM the pane came up before counting it. The first session
 * (`intoWindow` undefined) opens the crew window with `new-window` and returns its id; every later session
 * `split-window`s into that window id and re-`select-layout tiled`s so all roles stay evenly tiled and visible
 * at once (founder ruling #3424, refining #3418). `runTmux` awaits each client's async exit, so a spawn failure
 * or any non-zero exit — the swallowed failure #3418 closed — fails closed with `StandUpLaunchError` naming the
 * role + pane; a `LaunchedSession` therefore only ever exists for a confirmed-live pane. The tmux runner is
 * injected so the new-window / split-window / select-layout exit-code paths are unit-tested.
 */
export const launchSessionInTmux = (
	plan: LaunchPlan,
	targetSession: string,
	intoWindow: string | undefined,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<LaunchedSession, StandUpLaunchError> =>
	Effect.gen(function* () {
		const {placement, bind, session, cwd} = plan;
		const pane = placement.paneLabel;
		if (intoWindow === undefined) {
			// First session: open the crew window and capture its id (`-P -F '#{window_id}'`) so every later
			// pane splits into exactly this window, never a stale same-named one. `-c <cwd>` boots the pane in
			// its distinct launch cwd — the persisted-scope `projects[]` key its crew server is registered under (#3444).
			const opened = yield* runTmuxCommand([
				"new-window",
				"-t",
				targetSession,
				"-n",
				CREW_WINDOW,
				"-c",
				cwd,
				"-P",
				"-F",
				"#{window_id}",
				"claude",
				...bind.argv,
			]);
			if (opened.spawnError !== undefined || opened.code !== 0) {
				return yield* Effect.fail(launchFailure(session, pane, opened, "new-window"));
			}
			const window = opened.stdout.trim() || CREW_WINDOW;
			return {role: session.role, address: session.address, window, pane, pid: opened.pid};
		}
		// Later session: split into the crew window in this pane's distinct launch cwd (`-c`), then re-tile.
		const split = yield* runTmuxCommand([
			"split-window",
			"-t",
			intoWindow,
			"-c",
			cwd,
			"claude",
			...bind.argv,
		]);
		if (split.spawnError !== undefined || split.code !== 0) {
			return yield* Effect.fail(launchFailure(session, pane, split, "split-window"));
		}
		const tiled = yield* runTmuxCommand(["select-layout", "-t", intoWindow, "tiled"]);
		if (tiled.spawnError !== undefined || tiled.code !== 0) {
			return yield* Effect.fail(launchFailure(session, pane, tiled, "select-layout tiled"));
		}
		return {role: session.role, address: session.address, window: intoWindow, pane, pid: split.pid};
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
		const runId = (input.runId ?? randomUUID)();
		const localScope = input.localScope ?? productionLocalScopeRegistrar;
		const ensureTracker = input.ensureTracker ?? ensureTrackerRunning;
		const resolveTargetSession = input.resolveTargetSession ?? resolveTargetSessionDefault;
		const launch = input.launch ?? launchSessionInTmux;

		const config = yield* input.config ?? readLaunchConfig();
		// Fail fast on a version drift before starting the tracker or any session — channels vary
		// across CLI versions, so a mismatch is a stand-up to refuse (version-assert.ts / #3295).
		yield* assertPinnedCliVersion(config, input.readVersionOutput ?? readInstalledCliVersionOutput);
		const tracker = yield* ensureTracker(projectRoot);

		// Start-of-stand-up reaper (crash-safety, #3444): sweep any prior run's crew entries the persisted
		// local scope still carries — a launcher that died mid-run leaves entries this run clears here.
		yield* localScope.reap(projectRoot, serverName);

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
		// populated; the die guard is the unreachable branch that satisfies noUncheckedIndexedAccess. Each
		// pane also gets a distinct git-valid launch cwd (its isolated `projects[]` key, #3444) — resolved
		// here, before the register, so an unwritable cwd fails closed with zero panes up.
		const plans = yield* Effect.forEach(sessions, (session, i) => {
			const bind = binds[i];
			const placement = placements[i];
			if (bind === undefined || placement === undefined) {
				return Effect.die(`stand-up plan zip out of range for session "${session.role}"`);
			}
			return localScope
				.paneCwd(projectRoot, runId, placement.paneLabel)
				.pipe(Effect.map((cwd): LaunchPlan => ({session, bind, placement, cwd})));
		});

		// Register every pane's crew server into the persisted local scope in one locked atomic RMW (#3444):
		// the channel resolver reads persisted scopes, never the old inline `--mcp-config`. Each entry is under
		// its own distinct cwd key, so a pane booting in its cwd sees ONLY its own server (no role-lease storm).
		yield* localScope.register(
			plans.map(
				(plan): CrewLocalEntry => ({
					cwd: plan.cwd,
					serverName: plan.bind.serverName,
					serverConfig: plan.bind.serverConfig,
				}),
			),
		);

		// Resolve the target tmux session before placing any pane: the caller's CURRENT session inside
		// tmux (which always exists — dissolving the fresh-machine "no crew session" failure), else a
		// created fallback (founder ruling #3418). Last precondition before the no-partial-crew launch loop.
		const targetSession = yield* resolveTargetSession();
		// Launch the whole crew into ONE tiled window (founder ruling #3424): the first session opens the
		// crew window, and its resolved window id threads into every later session so they split into that
		// exact window. Sequential (not `forEach`) because each pane splits the window the first one opened;
		// any failed launch short-circuits fail-loud with no partial crew.
		const launched: LaunchedSession[] = [];
		let crewWindow: string | undefined;
		for (const plan of plans) {
			const session = yield* launch(plan, targetSession, crewWindow);
			launched.push(session);
			crewWindow ??= session.window;
		}
		return {tracker, launched};
	});

/** What a stand-down consumes: the project whose crew local-scope entries + launcher-owned cwd dirs to tear down. */
export interface StandDownInput {
	readonly projectRoot: string;
	/** The crew server name to sweep. Default: `SESSION_SERVER_NAME`. */
	readonly serverName?: string;
	/**
	 * Sweep the persisted crew entries under the crew-run prefix. Default: `reapCrewLocalScopeFor`
	 * (realpaths the prefix the same way `register` keyed it, against the real `~/.claude.json`).
	 * Injected in tests so no real config file is touched.
	 */
	readonly reap?: () => Effect.Effect<void, LocalScopeWriteError>;
}

/**
 * Tear this run's crew registration down (the symmetric `stand-down`, #3444): sweep every crew server
 * entry the persisted local scope carries under the crew-run prefix, then remove the launcher-owned
 * per-pane cwd dir tree. Removal is safe even while a crew is live — a booted stdio server is never
 * re-read against the file (fact #1). Idempotent: a second stand-down is a clean no-op.
 */
export const runStandDown = (input: StandDownInput): Effect.Effect<void, LocalScopeWriteError> =>
	Effect.gen(function* () {
		const {projectRoot} = input;
		const serverName = input.serverName ?? SESSION_SERVER_NAME;
		const reap = input.reap ?? (() => reapCrewLocalScopeFor(projectRoot, serverName));
		yield* reap();
		const runRoot = crewRunRoot(projectRoot);
		yield* Effect.try({
			try: () => rmSync(runRoot, {recursive: true, force: true}),
			catch: (cause) =>
				new LocalScopeWriteError({
					configPath: runRoot,
					reason: `cannot remove crew-run dir ${runRoot}: ${String(cause)}`,
				}),
		});
	});
