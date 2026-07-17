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
 * The production launcher: open a tmux window for the session under the launcher-default tmux session and
 * run `claude` there with the session's launch bind. Detached + unref'd + ignored stdio so the crew
 * outlives this launcher process (the `ensureTrackerRunning` spawn idiom). The thin, uncovered edge —
 * tests inject a recording launcher; only a synchronous spawn throw crosses the error channel.
 */
export const launchSessionInTmux = (
	plan: LaunchPlan,
): Effect.Effect<LaunchedSession, StandUpLaunchError> =>
	Effect.try({
		try: (): LaunchedSession => {
			const {placement, bind, session} = plan;
			const child = spawn(
				"tmux",
				["new-window", "-t", placement.session, "-n", placement.window, "claude", ...bind.argv],
				{detached: true, stdio: "ignore"},
			);
			child.unref();
			return {
				role: session.role,
				address: session.address,
				window: placement.window,
				pid: child.pid,
			};
		},
		catch: (cause) =>
			new StandUpLaunchError({
				role: plan.session.role,
				window: plan.placement.window,
				reason: `cannot launch claude into tmux window "${plan.placement.window}": ${String(cause)}`,
			}),
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

		const launched = yield* Effect.forEach(plans, launch);
		return {tracker, launched};
	});
