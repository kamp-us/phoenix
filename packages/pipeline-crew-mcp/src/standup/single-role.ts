/**
 * standup/single-role — dynamic single-member membership ops (issue #3519): add, remove, or respawn
 * ONE crew member without tearing the whole crew down and re-booting it. The whole-crew `stand-up` /
 * `stand-down` are all-or-nothing; a single-member change through them costs a full re-boot that kills
 * in-flight coder subagents, resets every standing session's context, and briefly leaves zero crew up.
 *
 * This is a CLI SURFACE over primitives that already exist — no new subsystem. The runtime already
 * does dynamic membership: a booted session auto-joins the tracker + channel via `AnnouncePresence`
 * (crew/session.ts), an engine deconflicts by resource claims, and a leaving member's presence/role
 * lease frees by TTL once its heartbeat stops (connection-is-lease — the tracker has no wire release
 * or disconnect hook, crew/tracker.ts). So the launcher's job is only the SCREEN + FILESYSTEM half:
 *   - `spawnRole` runs the SAME per-role launch step the whole-crew boot runs (`buildLaunchPlan` +
 *     `launchSessionInTmux`, extracted not forked, #3519 AC3), but SPLITS the pane into the RUNNING
 *     crew window instead of opening a new one — so no other member is disturbed. The new session
 *     announces its own presence + claims on boot; a HITL role (the cartographer) is spawnable here
 *     precisely because this is the explicit human spawn, and bind.ts already boots it idle (#3524).
 *   - `retireRole` kills the one member's pane (whose kill IS the connection-is-lease release), then
 *     reclaims the filesystem artifacts that don't self-clean: its inbox socket + its launcher-owned cwd.
 *     Every other member's lease + pane stays intact.
 *
 * The side-effecting seams (config, version, tracker, tmux runner, project scope, artifact cleanup) are
 * injected, defaulting to production — so the whole flow is unit-tested with no real tmux/filesystem, the
 * same idiom orchestrate.ts uses. A crew pane is identified by its `pane_start_command` (a documented tmux
 * format, grounded against tmux 3.6a): the launch argv carries the member's `--name <displayName>` verbatim
 * (the slug/uuid survives shell-quoting unmangled), so the displayName is the pane match key.
 */
import {randomUUID} from "node:crypto";
import {existsSync, readdirSync, rmSync} from "node:fs";
import {Effect, type FileSystem, type Path, Schema} from "effect";
import {type CrewRole, inboxSocketFor, kindOf, SESSION_SERVER_NAME} from "../crew/index.ts";
import type {
	ChannelPluginNotAllowedError,
	CrewServerNotRegisteredError,
	CrewSessionBinUnresolvableError,
} from "./bind.ts";
import {type LaunchConfig, type LaunchConfigError, readLaunchConfig} from "./config.ts";
import {
	ensureTrackerRunning,
	type TrackerHandle,
	type TrackerNotServingError,
} from "./ensure-tracker.ts";
import {
	buildLaunchPlan,
	CREW_WINDOW,
	FALLBACK_TMUX_SESSION,
	type LaunchedSession,
	type LaunchPlan,
	launchSessionInTmux,
	type ProjectScopeRegistrar,
	productionProjectScopeRegistrar,
	resolveTargetTmuxSession,
	runTmux,
	type StandUpLaunchError,
	type TmuxRunner,
	type TmuxSessionEnsureError,
	toRosterSession,
} from "./orchestrate.ts";
import {crewRunRoot, ProjectScopeWriteError} from "./register-project-scope.ts";
import {deriveOneSession} from "./session-set.ts";
import {computeTmuxPlacement, type TmuxPaneCollisionError} from "./tmux-placement.ts";
import {
	assertPinnedCliVersion,
	type CliVersionAssertError,
	readInstalledCliVersionOutput,
} from "./version-assert.ts";

/** The `session --role`/`--name` display identity of one member — a bridge is its role slug, an engine is `role-<instance>`. */
const displayNameOf = (role: CrewRole, instance: string): string =>
	kindOf(role) === "engine" ? `${role}-${instance}` : role;

// ── spawn-role ───────────────────────────────────────────────────────────────────────────────────

/**
 * `spawn-role` could not find a running `crew` window to split the new pane into. `spawn-role` ADDS a
 * member to a RUNNING crew (respawn/scale-up), so an absent crew window is a fail-closed refusal — run
 * `stand-up` first — never a silent new-window boot that would strand the member outside the crew view.
 */
export class CrewWindowNotRunningError extends Schema.TaggedErrorClass<CrewWindowNotRunningError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewWindowNotRunningError",
	{
		targetSession: Schema.String,
		reason: Schema.String,
	},
) {}

/** Every way `spawn-role` can abort — the launch-preconditions it shares with stand-up plus the missing-crew-window refusal. */
export type SpawnRoleError =
	| LaunchConfigError
	| CliVersionAssertError
	| TrackerNotServingError
	| CrewSessionBinUnresolvableError
	| CrewServerNotRegisteredError
	| ChannelPluginNotAllowedError
	| ProjectScopeWriteError
	| TmuxPaneCollisionError
	| TmuxSessionEnsureError
	| CrewWindowNotRunningError
	| StandUpLaunchError;

export interface SpawnRoleInput {
	/** The project root whose running tracker + crew window the new member joins. */
	readonly projectRoot: string;
	/** The role to spawn one member of — any roster role, including a human-in-the-loop one (the on-demand cartographer, #3524). */
	readonly role: CrewRole;
	/** The channel-ref name the member's crew MCP server registers under. Default: `SESSION_SERVER_NAME`. */
	readonly serverName?: string;
	/** Mints the id for this spawn's per-pane cwd dir (`<root>/.claude/crew-run/<runId>/`). Default: `randomUUID`. */
	readonly runId?: () => string;
	/** The project-scope collaborator (#3444). Default: `productionProjectScopeRegistrar`. */
	readonly localScope?: ProjectScopeRegistrar;
	/** The launch dimensions. Default: read the operator crew config. */
	readonly config?: Effect.Effect<LaunchConfig, LaunchConfigError>;
	/** The installed-CLI-version reader the pin is asserted against. Default: the real `claude --version`. */
	readonly readVersionOutput?: Effect.Effect<string, unknown>;
	/** Start-or-reuse the per-project tracker (idempotent — dials the running one). Default: `ensureTrackerRunning`. */
	readonly ensureTracker?: (
		projectRoot: string,
	) => Effect.Effect<TrackerHandle, TrackerNotServingError>;
	/** Mints the engine instance's distinct id. Default: `randomUUID`. */
	readonly instanceId?: () => string;
	/** Resolve the tmux session whose crew window the pane splits into. Default: the caller's current session, else the fallback. */
	readonly resolveTargetSession?: () => Effect.Effect<string, TmuxSessionEnsureError>;
	/** The tmux runner for the window-resolution probe. Default: `runTmux`. */
	readonly runTmux?: TmuxRunner;
	/** Launch one planned session as a pane. Default: `launchSessionInTmux`. */
	readonly launch?: (
		plan: LaunchPlan,
		targetSession: string,
		intoWindow: string | undefined,
	) => Effect.Effect<LaunchedSession, StandUpLaunchError>;
}

/** What a completed `spawn-role` returns: the tracker it joined and the one member it launched. */
export interface SpawnRoleResult {
	readonly tracker: TrackerHandle;
	readonly launched: LaunchedSession;
}

/** Resolve the tmux session windows open into — the caller's current session inside tmux, else the created fallback. */
const resolveTargetSessionDefault = (
	runTmuxCommand: TmuxRunner,
): Effect.Effect<string, TmuxSessionEnsureError> =>
	resolveTargetTmuxSession(
		{inTmux: process.env.TMUX !== undefined, fallbackSession: FALLBACK_TMUX_SESSION},
		runTmuxCommand,
	);

/**
 * Resolve the id of the RUNNING `crew` window in `targetSession` — the window `spawn-role` splits the
 * new pane into. Fails closed if the tmux probe errors or no `crew` window is up (run `stand-up` first).
 * The tmux runner is injected so the found / absent branches are unit-tested without a real tmux.
 */
export const resolveCrewWindowId = (
	targetSession: string,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<string, CrewWindowNotRunningError> =>
	Effect.gen(function* () {
		const listed = yield* runTmuxCommand([
			"list-windows",
			"-t",
			targetSession,
			"-F",
			"#{window_id} #{window_name}",
		]);
		if (listed.spawnError !== undefined || listed.code !== 0) {
			return yield* Effect.fail(
				new CrewWindowNotRunningError({
					targetSession,
					reason:
						listed.spawnError ??
						`tmux list-windows for "${targetSession}" exited ${listed.code ?? listed.signal}`,
				}),
			);
		}
		for (const line of listed.stdout.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const sep = trimmed.indexOf(" ");
			const id = sep === -1 ? trimmed : trimmed.slice(0, sep);
			const name = sep === -1 ? "" : trimmed.slice(sep + 1);
			if (name === CREW_WINDOW) return id;
		}
		return yield* Effect.fail(
			new CrewWindowNotRunningError({
				targetSession,
				reason: `no "${CREW_WINDOW}" window is running in tmux session "${targetSession}" — run stand-up first`,
			}),
		);
	});

/**
 * Add ONE member to the running crew (issue #3519): assert the same launch preconditions stand-up does
 * (config, pinned CLI version), ensure the tracker (idempotent — reuses the running one), derive the
 * single session (a bridge singleton or one fresh-instance engine), build its launch plan through the
 * SHARED `buildLaunchPlan` (never a forked launch path, AC3), register just this pane's project scope
 * (idempotent boot gates, untouched siblings), then SPLIT it into the running crew window. The booted
 * session auto-joins the tracker + channel via `AnnouncePresence` and (for an engine) deconflicts by
 * resource claims — the launcher does none of that, it only puts the pane on screen.
 */
export const spawnRole = (
	input: SpawnRoleInput,
): Effect.Effect<SpawnRoleResult, SpawnRoleError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {projectRoot, role} = input;
		const serverName = input.serverName ?? SESSION_SERVER_NAME;
		const instanceId = input.instanceId ?? randomUUID;
		const runId = (input.runId ?? randomUUID)();
		const localScope = input.localScope ?? productionProjectScopeRegistrar;
		const ensureTracker = input.ensureTracker ?? ensureTrackerRunning;
		const runTmuxCommand = input.runTmux ?? runTmux;
		const resolveTargetSession =
			input.resolveTargetSession ?? (() => resolveTargetSessionDefault(runTmuxCommand));
		const launch = input.launch ?? launchSessionInTmux;

		const config = yield* input.config ?? readLaunchConfig();
		// Same fail-fast the whole-crew boot does: channels vary across CLI versions, so a drifted pin is
		// a spawn to refuse before touching the tracker or launching (version-assert.ts / #3295).
		yield* assertPinnedCliVersion(config, input.readVersionOutput ?? readInstalledCliVersionOutput);
		const tracker = yield* ensureTracker(projectRoot);

		const session = deriveOneSession({role, instanceId});
		// One session ⇒ no pane-label collision is possible; computeTmuxPlacement is reused (not a
		// re-implemented placeOne) so the pane label derivation stays the single stand-up code path.
		const placements = yield* computeTmuxPlacement([toRosterSession(session)]);
		const placement = placements[0];
		if (placement === undefined) {
			return yield* Effect.die(`spawn-role placement missing for role "${role}"`);
		}
		const plan = yield* buildLaunchPlan(session, placement, {
			projectRoot,
			serverName,
			config,
			runId,
			localScope,
		});

		// Register just THIS pane's project scope (+ idempotent folder-trust / server-approval boot gates):
		// adds one leaf `.mcp.json` in the pane's own cwd, on no running member's ancestor chain, so no
		// sibling's channel isolation is disturbed (#3444).
		yield* localScope.register({
			projectRoot,
			runId,
			serverName,
			entries: [
				{cwd: plan.cwd, serverName: plan.bind.serverName, serverConfig: plan.bind.serverConfig},
			],
		});

		const targetSession = yield* resolveTargetSession();
		const crewWindow = yield* resolveCrewWindowId(targetSession, runTmuxCommand);
		// `intoWindow` DEFINED ⇒ launchSessionInTmux splits into the existing crew window + re-tiles, never
		// opens a new one — the "add a pane without disturbing any other member" path (AC1).
		const launched = yield* launch(plan, targetSession, crewWindow);
		return {tracker, launched};
	});

// ── retire-role ──────────────────────────────────────────────────────────────────────────────────

/** `retire-role` was handed an instance argument inconsistent with the role's kind — an engine needs one, a bridge takes none. */
export class RetireRoleArgError extends Schema.TaggedErrorClass<RetireRoleArgError>()(
	"@kampus/pipeline-crew-mcp/standup/RetireRoleArgError",
	{
		role: Schema.String,
		reason: Schema.String,
	},
) {}

/** No single crew pane matched the member to retire — zero matches (already gone) or, defensively, more than one. */
export class CrewPaneNotFoundError extends Schema.TaggedErrorClass<CrewPaneNotFoundError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewPaneNotFoundError",
	{
		displayName: Schema.String,
		matched: Schema.Number,
		reason: Schema.String,
	},
) {}

/** The member's tmux pane was found but `kill-pane` did not succeed — the retire fails closed rather than half-tear-down. */
export class CrewPaneKillError extends Schema.TaggedErrorClass<CrewPaneKillError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewPaneKillError",
	{
		paneId: Schema.String,
		reason: Schema.String,
	},
) {}

/** Every way `retire-role` can abort. */
export type RetireRoleError =
	| RetireRoleArgError
	| CrewPaneNotFoundError
	| CrewPaneKillError
	| ProjectScopeWriteError;

/**
 * The filesystem artifacts a retired member leaves that don't self-reclaim: its inbox socket and its
 * launcher-owned cwd dir(s). Injected so `retireRole` is unit-tested with no real filesystem, mirroring
 * orchestrate.ts's `ProjectScopeRegistrar`.
 */
export interface RetireArtifacts {
	/** Remove the member's inbox socket file (`inboxSocketFor(role, instance)`); a missing socket is a clean no-op. */
	readonly removeInboxSocket: (
		role: CrewRole,
		instance: string,
	) => Effect.Effect<void, ProjectScopeWriteError>;
	/** Remove the member's launcher-owned pane cwd(s) — its `<cwdLabel>` dir under any crew-run id — leaving other members' dirs. */
	readonly removePaneCwd: (
		projectRoot: string,
		cwdLabel: string,
	) => Effect.Effect<void, ProjectScopeWriteError>;
}

/** Remove one path with `force` (a missing path is a no-op), wrapped as a fail-closed `ProjectScopeWriteError`. */
const removePath = (path: string): Effect.Effect<void, ProjectScopeWriteError> =>
	Effect.try({
		try: () => rmSync(path, {recursive: true, force: true}),
		catch: (cause) =>
			new ProjectScopeWriteError({
				configPath: path,
				reason: `cannot remove ${path}: ${String(cause)}`,
			}),
	});

/**
 * The production artifact-cleanup: the inbox socket resolves to a deterministic path per member; the pane
 * cwd is `<root>/.claude/crew-run/<runId>/<cwdLabel>` and `retire-role` does not know the (stand-up- or
 * spawn-minted) runId, so it removes the `<cwdLabel>` dir under EVERY run dir — the label is unique to
 * this member (a bridge's role slug / an engine's instance id), so no sibling's dir is touched.
 */
export const productionRetireArtifacts: RetireArtifacts = {
	removeInboxSocket: (role, instance) => removePath(inboxSocketFor(role, instance)),
	removePaneCwd: (projectRoot, cwdLabel) =>
		Effect.gen(function* () {
			const runRoot = crewRunRoot(projectRoot);
			if (!existsSync(runRoot)) return;
			const runDirs = yield* Effect.try({
				try: () => readdirSync(runRoot, {withFileTypes: true}),
				catch: (cause) =>
					new ProjectScopeWriteError({
						configPath: runRoot,
						reason: `cannot read crew-run dir ${runRoot}: ${String(cause)}`,
					}),
			});
			for (const entry of runDirs) {
				if (!entry.isDirectory()) continue;
				yield* removePath(`${runRoot}/${entry.name}/${cwdLabel}`);
			}
		}),
};

export interface RetireRoleInput {
	/** The project root whose launcher-owned pane cwd is reclaimed. */
	readonly projectRoot: string;
	/** The role of the member to retire. */
	readonly role: CrewRole;
	/** The engine instance to retire (REQUIRED for an engine role, cardinality-N; a bridge is a singleton and takes none). */
	readonly instance?: string | undefined;
	/** The tmux runner for the list-panes / kill-pane calls. Default: `runTmux`. */
	readonly runTmux?: TmuxRunner;
	/** The filesystem artifact cleanup. Default: `productionRetireArtifacts`. */
	readonly artifacts?: RetireArtifacts;
}

/** What a completed `retire-role` returns: which pane it killed and the member it identified. */
export interface RetireRoleResult {
	readonly paneId: string;
	readonly role: CrewRole;
	readonly instance: string;
}

/**
 * Find the ONE crew pane for `displayName` by its `pane_start_command` — the launch argv carries
 * `--name <displayName>` verbatim (the slug/uuid survives shell-quoting unmangled), and `claude` marks
 * it a crew pane. Fails closed on zero matches (already gone) or, defensively, more than one. The tmux
 * runner is injected so the found / absent / ambiguous branches are unit-tested without a real tmux.
 */
export const findCrewPaneId = (
	displayName: string,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<string, CrewPaneNotFoundError> =>
	Effect.gen(function* () {
		const listed = yield* runTmuxCommand([
			"list-panes",
			"-a",
			"-F",
			"#{pane_id}::#{pane_start_command}",
		]);
		if (listed.spawnError !== undefined || listed.code !== 0) {
			return yield* Effect.fail(
				new CrewPaneNotFoundError({
					displayName,
					matched: 0,
					reason: listed.spawnError ?? `tmux list-panes exited ${listed.code ?? listed.signal}`,
				}),
			);
		}
		const matches: string[] = [];
		for (const line of listed.stdout.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const sep = trimmed.indexOf("::");
			if (sep === -1) continue;
			const paneId = trimmed.slice(0, sep);
			const command = trimmed.slice(sep + 2);
			if (command.includes("claude") && command.includes(displayName)) matches.push(paneId);
		}
		if (matches.length !== 1 || matches[0] === undefined) {
			return yield* Effect.fail(
				new CrewPaneNotFoundError({
					displayName,
					matched: matches.length,
					reason:
						matches.length === 0
							? `no running crew pane matches "${displayName}" — already retired, or the crew is down`
							: `${matches.length} panes match "${displayName}" — refusing to kill ambiguously`,
				}),
			);
		}
		return matches[0];
	});

/**
 * Retire ONE crew member (issue #3519): validate the instance against the role's kind, find its pane,
 * `kill-pane` it, then reclaim its filesystem artifacts (inbox socket + launcher cwd). Killing the pane
 * stops its heartbeat, so its presence/role lease frees by TTL (connection-is-lease — the tracker has no
 * wire release; crew/tracker.ts) and, for an engine, so do its resource claims — leaving every OTHER
 * member's lease + pane intact (AC4). The launcher never speaks to the tracker here; the runtime frees
 * the lease on its own once the connection dies.
 */
export const retireRole = (
	input: RetireRoleInput,
): Effect.Effect<RetireRoleResult, RetireRoleError> =>
	Effect.gen(function* () {
		const {projectRoot, role} = input;
		const runTmuxCommand = input.runTmux ?? runTmux;
		const artifacts = input.artifacts ?? productionRetireArtifacts;
		const kind = kindOf(role);

		// Make the invalid states unrepresentable at the boundary: an engine is cardinality-N so it MUST
		// be named by instance; a bridge is the singleton so an instance is meaningless.
		if (kind === "engine" && (input.instance === undefined || input.instance.length === 0)) {
			return yield* Effect.fail(
				new RetireRoleArgError({
					role,
					reason: `"${role}" is a cardinality-N engine — pass the instance id of the member to retire`,
				}),
			);
		}
		if (kind === "bridge" && input.instance !== undefined) {
			return yield* Effect.fail(
				new RetireRoleArgError({
					role,
					reason: `"${role}" is a singleton bridge — it takes no instance`,
				}),
			);
		}
		const instance = input.instance ?? "";

		// The pane is matched on the launch `--name` displayName; the cwd dir + inbox socket use the pane
		// label (a bridge's role slug, an engine's instance id) — the two identities the launcher stamped.
		const displayName = displayNameOf(role, instance);
		const cwdLabel = kind === "engine" ? instance : role;

		const paneId = yield* findCrewPaneId(displayName, runTmuxCommand);
		const killed = yield* runTmuxCommand(["kill-pane", "-t", paneId]);
		if (killed.spawnError !== undefined || killed.code !== 0) {
			return yield* Effect.fail(
				new CrewPaneKillError({
					paneId,
					reason:
						killed.spawnError ??
						`tmux kill-pane -t ${paneId} exited ${killed.code ?? killed.signal}`,
				}),
			);
		}

		yield* artifacts.removeInboxSocket(role, instance);
		yield* artifacts.removePaneCwd(projectRoot, cwdLabel);
		return {paneId, role, instance};
	});
